/**
 * The graph loading session: everything that happens between choosing a repository and having a
 * graph on screen, with no React in it.
 *
 * The lifecycle is one asynchronous workflow — read the budget, list, ask before spending,
 * resolve, persist, lay out — crossed by three ways of ending early: the viewer cancels, the token
 * changes, or the page goes away. Expressed as effects inside a component, each of those crossings
 * had to be rediscovered at every await point, and the ones that were missed are exactly the
 * failures this module exists to close: a confirmation left unanswered forever, and a layout that
 * either lied about why it failed or never said that it had.
 *
 * Keeping it a plain object means every transition is reachable from a test without mounting
 * anything, and the component is left with rendering.
 *
 * The phase names are the ones the interface already used. They map onto the lifecycle vocabulary
 * as: `gate` is the rate-limit probe and the viewer's choice, `listing` and `resolving` are the
 * fetch, `confirm` awaits the confirmation, `drawing` computes the layout, and `ready` and
 * `failed` are the two ends.
 */

import { readCache, writeCache, type CachedGraph } from './cache'
import { buildGraph, type IssueGraph } from './graph'
import {
  loadRepositoryGraph,
  readRateLimit,
  type LoadFailure,
  type LoadResult,
  type RateLimitStatus,
  type RepositoryGraphData,
} from './github'
import type { RepoTarget } from './route'
import { hasSnapshot, readSnapshot, type SnapshotRead, type SnapshotView } from './snapshot'
import { rememberTarget } from './suggestions'

/**
 * Whose copy an on-screen graph is. A saved copy is the viewer's own earlier read; a shared one
 * arrived in a link and was taken by somebody else. Both are point-in-time, but only one of them
 * is theirs, and a recipient deciding whether to trust what is on screen needs to know which.
 */
export interface SavedCopyProvenance {
  savedAt: Date
  includedClosed: boolean
  source: 'saved' | 'shared'
}

export type SavedCopyDecision =
  | { kind: 'open'; provenance: SavedCopyProvenance }
  | { kind: 'requires-latest'; reason: string }

/** A saved copy can only satisfy views covered by the GitHub read that produced it. */
export function decideSavedCopyOpen(
  cached: CachedGraph,
  showClosed: boolean,
): SavedCopyDecision {
  if (showClosed && !cached.data.includedClosed) {
    return {
      kind: 'requires-latest',
      reason: 'A wider GitHub read is required to include closed blockers.',
    }
  }

  return {
    kind: 'open',
    provenance: {
      savedAt: cached.savedAt,
      includedClosed: cached.data.includedClosed,
      source: 'saved',
    },
  }
}

/**
 * How a session can fail.
 *
 * Laying the graph out is not a request, so it cannot fail in any of the ways a request does.
 * Folding it into the network case told the viewer that GitHub could not be reached when GitHub
 * had already answered, and pointed them at the one thing that was working.
 */
export type SessionFailure = LoadFailure | { kind: 'layout'; message: string }

export type Phase =
  | { kind: 'gate'; status: RateLimitStatus | null; checking: boolean }
  | { kind: 'listing' }
  | { kind: 'confirm'; cost: number; status: RateLimitStatus | null; decide: (ok: boolean) => void }
  | { kind: 'resolving'; done: number; total: number }
  /** The layout runs off the main path of the load, and on a large graph it is not instant. */
  | { kind: 'drawing' }
  | { kind: 'failed'; failure: SessionFailure }
  | {
      kind: 'ready'
      graph: IssueGraph
      savedCopy: SavedCopyProvenance | null
      /** Kept beside the drawn graph because a shareable link is built from the data, not the layout. */
      snapshot: SnapshotView
    }

export interface SessionState {
  phase: Phase
  /** Why a shared link was abandoned, when one was, so the gate it lands on can say so. */
  linkProblem: string | null
  /** Why a read in flight was stopped, when the token behind it changed. */
  stopped: string | null
}

/**
 * Everything the session reaches outside itself. Named as one object so a test can supply its own
 * without a network, a clock, or a browser.
 */
export interface SessionEffects {
  readRateLimit: typeof readRateLimit
  loadRepositoryGraph: typeof loadRepositoryGraph
  buildGraph: typeof buildGraph
  readSnapshot: (hash: string, slug: string) => Promise<SnapshotRead>
  readCache: (slug: string) => CachedGraph | null
  writeCache: (slug: string, data: RepositoryGraphData) => void
  rememberTarget: (target: RepoTarget) => void
  /** Drops a snapshot out of the address bar once the page has stopped showing it. */
  clearFragment: () => void
  now: () => Date
}

export const browserEffects: SessionEffects = {
  readRateLimit,
  loadRepositoryGraph,
  buildGraph,
  readSnapshot,
  readCache,
  writeCache,
  rememberTarget,
  clearFragment: () => {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  },
  now: () => new Date(),
}

export interface SessionOptions {
  target: RepoTarget
  /**
   * The canonical spelling, which keys everything stored or matched. Kept apart from what the
   * viewer typed, because keying stored state on the spelling forks one repository across its
   * spellings.
   */
  identity: string
  token: string
  /** The address fragment as it stood when the session opened; a snapshot may be in it. */
  fragment: string
  /**
   * Called when a load ended in the viewer's own cancellation, which rewinds the view rather than
   * reporting a failure: nothing went wrong and nothing was spent.
   */
  onCancelled: (why: string | null) => void
  effects?: SessionEffects
}

/**
 * Whether a token change has to stop what the page is doing.
 *
 * A load in progress carries the token it started with, so it must be stopped. A gate has sent
 * nothing, and a drawn graph or a reported failure is finished: none of them is holding a request
 * that could still leave with the wrong credential, and discarding a graph somebody is reading
 * would be a worse answer than leaving it.
 */
export function stopsForTokenChange(kind: Phase['kind']): boolean {
  return kind === 'listing' || kind === 'confirm' || kind === 'resolving' || kind === 'drawing'
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

const CHECKING_GATE: Phase = { kind: 'gate', status: null, checking: true }

export class GraphSession {
  readonly #options: SessionOptions
  readonly #effects: SessionEffects
  readonly #sharedLink: boolean
  readonly #cached: CachedGraph | null
  readonly #listeners = new Set<() => void>()

  #token: string
  #state: SessionState
  /** The load, the layout after it, and the confirmation in the middle all abort together. */
  #work: AbortController | null = null
  /** Reading the budget is separate: it costs nothing and outlives no load. */
  #probe: AbortController | null = null
  /**
   * Answers the confirmation the loader is awaiting. Held here so resetting or closing the session
   * can settle it explicitly, rather than depending on an abort listener having been reached: an
   * unsettled promise leaves the loader suspended for the lifetime of the page.
   */
  #settleConfirmation: ((approved: boolean) => void) | null = null
  /**
   * Distinguishes the run that is current from every earlier one. An abort signal cannot do this
   * alone, because a layout is not a request and never sees the signal; the counter is what lets a
   * result that arrives after its run was replaced be dropped instead of drawn.
   */
  #run = 0
  #closed = false

  constructor(options: SessionOptions) {
    this.#options = options
    this.#effects = options.effects ?? browserEffects
    this.#token = options.token
    this.#sharedLink = hasSnapshot(options.fragment)
    // Read once, because the gate has to describe a copy that does not change under it.
    this.#cached = this.#effects.readCache(options.identity)
    this.#state = {
      // A snapshot in the fragment opens straight into the drawing, skipping the gate: there is
      // nothing to weigh, because drawing it costs nothing.
      phase: this.#sharedLink ? { kind: 'drawing' } : CHECKING_GATE,
      linkProblem: null,
      stopped: null,
    }
  }

  /** The saved copy this browser already holds for the repository, read when the session opened. */
  get cached(): CachedGraph | null {
    return this.#cached
  }

  getState = (): SessionState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Starts the session, and restarts one that was closed.
   *
   * Restarting is not a convenience: React mounts, unmounts and remounts under StrictMode, so a
   * session that could only ever be closed once would come back dead.
   */
  begin(): void {
    this.#closed = false
    this.#run += 1
    if (this.#sharedLink) {
      this.#state = { phase: { kind: 'drawing' }, linkProblem: null, stopped: null }
      this.#notify()
      this.#openSharedLink(this.#run)
      return
    }
    this.#state = { phase: CHECKING_GATE, linkProblem: null, stopped: null }
    this.#notify()
    this.#probeBudget()
  }

  /** Reads the repository from GitHub. */
  start(includeClosed: boolean): void {
    if (this.#closed) return
    const controller = this.#beginWork()
    const run = this.#run
    this.#set({ phase: { kind: 'listing' }, stopped: null })

    this.#effects
      .loadRepositoryGraph(this.#options.target, {
        signal: controller.signal,
        token: this.#token,
        includeClosed,
        onProgress: ({ done, total }) => {
          if (this.#current(run, controller)) this.#set({ phase: { kind: 'resolving', done, total } })
        },
        confirmDependencies: (cost) => this.#askToSpend(cost, controller),
      })
      .then((result) => this.#drawLoaded(result, includeClosed, run, controller))
      .catch((error: unknown) => {
        if (!this.#current(run, controller)) return
        this.#set({
          phase: {
            kind: 'failed',
            failure: { kind: 'network', message: messageOf(error, 'The request failed.') },
          },
        })
      })
  }

  /**
   * Draws the copy this browser saved from an earlier read, when it covers the requested view.
   *
   * The layout is the only asynchronous step, and it is the one that had neither a rejection
   * handler nor a way to be cancelled: a failure left `Laying out the graph…` on screen with
   * nothing coming, and a session closed mid-layout drew into a page that had gone.
   */
  openSavedCopy(showClosed: boolean): void {
    if (this.#closed) return
    const copy = this.#cached
    if (!copy) return
    const decision = decideSavedCopyOpen(copy, showClosed)
    if (decision.kind !== 'open') return

    const controller = this.#beginWork()
    const run = this.#run
    this.#set({ phase: { kind: 'drawing' }, stopped: null })

    // This browser's own copy of a read it made from GitHub, under this repository's key.
    void this.#effects
      .buildGraph(copy.data, this.#options.target, { showClosed, trustedIdentity: true })
      .then((graph) => {
        if (!this.#current(run, controller)) return
        this.#set({
          phase: {
            kind: 'ready',
            graph,
            savedCopy: decision.provenance,
            snapshot: { data: copy.data, capturedAt: copy.savedAt, showClosed },
          },
        })
      })
      .catch((error: unknown) => {
        if (!this.#current(run, controller)) return
        this.#set({ phase: { kind: 'failed', failure: this.#layoutFailure(error) } })
      })
  }

  /**
   * Applies a change of token.
   *
   * A load already in flight carries the token it started with: its request options were built
   * once, so everything still queued would keep sending a credential the viewer has just replaced
   * or removed. Stopping it is the only reading of "takes effect on the next request" that is true.
   */
  setToken(token: string): void {
    if (token === this.#token) return
    this.#token = token
    const stops = stopsForTokenChange(this.#state.phase.kind)
    this.#cancelWork()

    if (stops) {
      this.#set({
        phase: CHECKING_GATE,
        stopped: token
          ? 'The read was stopped when the token changed. Nothing further was sent without it.'
          : 'The read was stopped when the token was removed. Nothing further was sent with it.',
      })
      this.#probeBudget()
      return
    }
    // The budget a gate quotes depends on whether a token is set, so it has to be read again.
    if (this.#state.phase.kind === 'gate') this.#probeBudget()
  }

  /** Stops everything in flight and settles anything waiting on an answer. */
  close(): void {
    this.#closed = true
    this.#run += 1
    this.#probe?.abort()
    this.#probe = null
    this.#cancelWork()
  }

  /* Internals ------------------------------------------------------------- */

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }

  #set(next: Partial<SessionState>): void {
    this.#state = { ...this.#state, ...next }
    this.#notify()
  }

  /** Whether a result belongs to the run that is still current, and was not aborted under it. */
  #current(run: number, controller: AbortController): boolean {
    return !this.#closed && run === this.#run && !controller.signal.aborted
  }

  #beginWork(): AbortController {
    this.#cancelWork()
    this.#run += 1
    const controller = new AbortController()
    this.#work = controller
    return controller
  }

  #cancelWork(): void {
    // Settled before the abort rather than by it, so the loader is released even when the
    // confirmation was never given a listener to hear.
    this.#settleConfirmation?.(false)
    this.#settleConfirmation = null
    this.#work?.abort()
    this.#work = null
  }

  #layoutFailure(error: unknown): SessionFailure {
    return { kind: 'layout', message: messageOf(error, 'The layout could not be computed.') }
  }

  /**
   * Reading the budget costs nothing — GitHub documents /rate_limit as not counted — so the gate
   * can always open with real numbers instead of an assumption about what is left.
   * https://docs.github.com/en/rest/rate-limit/rate-limit
   */
  #probeBudget(): void {
    this.#probe?.abort()
    const controller = new AbortController()
    this.#probe = controller

    void this.#effects
      .readRateLimit({ signal: controller.signal, token: this.#token })
      .then((status) => this.#recordBudget(status, controller))
      // The reader answers `null` for a failed read, so this only catches a broken one; the gate
      // still has to become usable, quoting the ceiling rather than a count.
      .catch(() => this.#recordBudget(null, controller))
  }

  #recordBudget(status: RateLimitStatus | null, controller: AbortController): void {
    if (this.#closed || controller.signal.aborted) return
    const { phase } = this.#state
    if (phase.kind !== 'gate') return
    this.#set({ phase: { ...phase, status, checking: false } })
  }

  /**
   * Asks the viewer to approve the dependency requests, with the budget read immediately before so
   * the number in front of them is current.
   */
  #askToSpend(cost: number, controller: AbortController): Promise<boolean> {
    return this.#effects
      .readRateLimit({ signal: controller.signal, token: this.#token })
      .then((status) => {
        if (controller.signal.aborted || this.#closed) return false
        return new Promise<boolean>((resolve) => {
          let settled = false
          const settle = (approved: boolean) => {
            if (settled) return
            settled = true
            controller.signal.removeEventListener('abort', onAbort)
            if (this.#settleConfirmation === settle) this.#settleConfirmation = null
            resolve(approved)
          }
          // Nothing has been sent yet, so an abort here answers the question with "no" rather than
          // leaving the load awaiting a decision the interface can no longer offer.
          const onAbort = () => settle(false)

          this.#settleConfirmation = settle
          controller.signal.addEventListener('abort', onAbort, { once: true })
          if (controller.signal.aborted) {
            settle(false)
            return
          }
          this.#set({ phase: { kind: 'confirm', cost, status, decide: settle } })
        })
      })
  }

  async #drawLoaded(
    result: LoadResult,
    includeClosed: boolean,
    run: number,
    controller: AbortController,
  ): Promise<void> {
    if (!this.#current(run, controller)) return

    if (!result.ok) {
      // The viewer's own answer at the confirmation, which rewinds the view instead of reporting
      // a failure: nothing went wrong, and nothing was spent.
      if (result.failure.kind === 'cancelled') this.#options.onCancelled(null)
      else this.#set({ phase: { kind: 'failed', failure: result.failure } })
      return
    }

    this.#effects.rememberTarget(this.#options.target)
    this.#effects.writeCache(this.#options.identity, result.data)
    this.#set({ phase: { kind: 'drawing' } })

    let graph: IssueGraph
    try {
      // Read from GitHub just now, so the payloads may name the repository they came from.
      graph = await this.#effects.buildGraph(result.data, this.#options.target, {
        showClosed: includeClosed,
        trustedIdentity: true,
      })
    } catch (error) {
      if (this.#current(run, controller)) {
        this.#set({ phase: { kind: 'failed', failure: this.#layoutFailure(error) } })
      }
      return
    }

    if (!this.#current(run, controller)) return
    this.#set({
      phase: {
        kind: 'ready',
        graph,
        savedCopy: null,
        snapshot: { data: result.data, capturedAt: this.#effects.now(), showClosed: includeClosed },
      },
    })
  }

  /**
   * Draws the shared link, or explains why it cannot and falls back to the ordinary gate.
   *
   * The snapshot is drawn at the choice the sender drew it with, which the link records for
   * exactly this reason — not at the coverage behind it, which can be wider, and not at the
   * recipient's own preference, which is about a repository they have not read. Nothing is written
   * to this browser's cache either: it is somebody else's copy, and a later visit must not be
   * offered it as this viewer's own.
   */
  #openSharedLink(run: number): void {
    const isCurrent = () => !this.#closed && run === this.#run

    void this.#effects
      .readSnapshot(this.#options.fragment, this.#options.identity)
      .then(async (read) => {
        if (!isCurrent()) return
        if (read.kind !== 'snapshot') {
          this.#abandonLink(read.kind === 'invalid' ? read.reason : null)
          return
        }

        let graph: IssueGraph
        try {
          // Somebody else's link, so its payloads do not get to say which repository this is:
          // `readSnapshot` bound it to the one in the path, and that binding is the whole guarantee.
          graph = await this.#effects.buildGraph(read.view.data, this.#options.target, {
            showClosed: read.view.showClosed,
          })
        } catch {
          // The link was read; the drawing is what failed, and saying otherwise would send the
          // recipient back to the sender over a fault on this side.
          if (isCurrent()) this.#abandonLink('This shared link was read, but could not be drawn.')
          return
        }

        if (!isCurrent()) return
        this.#set({
          phase: {
            kind: 'ready',
            graph,
            savedCopy: {
              savedAt: read.view.capturedAt,
              // What the recipient is looking at, which is the sender's drawing rather than the
              // wider read that may lie behind it.
              includedClosed: read.view.showClosed,
              source: 'shared',
            },
            snapshot: read.view,
          },
        })
      })
      .catch(() => {
        if (isCurrent()) this.#abandonLink('This shared link could not be read.')
      })
  }

  /**
   * A link that could not be read is not worth retrying on the next reload, and leaving it in the
   * address bar would describe a graph the page is not showing.
   */
  #abandonLink(reason: string | null): void {
    this.#effects.clearFragment()
    this.#set({ phase: CHECKING_GATE, linkProblem: reason })
    this.#probeBudget()
  }
}
