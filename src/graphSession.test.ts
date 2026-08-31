import { describe, expect, it } from 'vitest'

import type { CachedGraph } from './cache'
import type { IssueGraph } from './graph'
import type {
  LoadOptions,
  LoadResult,
  RateLimitStatus,
  RepositoryGraphData,
} from './github'
import {
  GraphSession,
  stopsForTokenChange,
  type Phase,
  type SessionEffects,
  type SessionOptions,
} from './graphSession'
import type { RepoTarget } from './route'
import type { SnapshotRead, SnapshotView } from './snapshot'

/**
 * The session is a plain object, so every one of these runs it for real: no component is mounted
 * and nothing is mocked out of the module graph. What is supplied instead is the outside world —
 * the network, the store, the clock — which is the whole reason it takes its effects as an
 * argument.
 */

const target: RepoTarget = { owner: 'martonpaulo', repo: 'issues-graph' }
const IDENTITY = 'martonpaulo/issues-graph'

const data: RepositoryGraphData = {
  issues: [],
  blockers: new Map(),
  complete: true,
  unresolved: [],
  rateLimited: false,
  rateLimitReset: null,
  requestCount: 1,
  rateLimit: null,
  includedClosed: false,
}

const graph: IssueGraph = {
  nodes: [],
  edges: [],
  groups: [],
  identity: IDENTITY,
  complete: true,
  unresolved: [],
  rateLimited: false,
  rateLimitReset: null,
  requestCount: 1,
}

const BUDGET: RateLimitStatus = { limit: 60, remaining: 41, reset: null }

/** Lets every already-queued promise callback run, which is what the session is built out of. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A promise with its settlement in hand, for holding a step open until a test releases it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Harness {
  session: GraphSession
  /** Every phase the session published, in order, so a transition can be asserted on. */
  phases: Phase[]
  cancelled: (string | null)[]
  cached: [string, RepositoryGraphData][]
  remembered: RepoTarget[]
  /** Every repository whose saved data the session was asked to remove. */
  forgotten: string[]
  fragmentsCleared: number
  /** How often the session terminated the layout engine. */
  enginesDiscarded: number
}

function open(
  overrides: Partial<SessionEffects> = {},
  options: Partial<SessionOptions> = {},
): Harness {
  const cancelled: (string | null)[] = []
  const cached: [string, RepositoryGraphData][] = []
  const remembered: RepoTarget[] = []
  const forgotten: string[] = []
  const record = { fragmentsCleared: 0, enginesDiscarded: 0 }

  const effects: SessionEffects = {
    readRateLimit: async () => BUDGET,
    loadRepositoryGraph: async (): Promise<LoadResult> => ({ ok: true, data }),
    buildGraph: async () => graph,
    discardLayoutEngine: () => void (record.enginesDiscarded += 1),
    readSnapshot: async (): Promise<SnapshotRead> => ({ kind: 'none' }),
    readCache: () => null,
    writeCache: (slug, value) => {
      cached.push([slug, value])
      return { ok: true }
    },
    rememberTarget: (value) => void remembered.push(value),
    clearRepositoryData: (slug) => {
      forgotten.push(slug)
      return { ok: true }
    },
    clearFragment: () => void (record.fragmentsCleared += 1),
    now: () => new Date('2026-08-31T12:00:00Z'),
    ...overrides,
  }

  const session = new GraphSession({
    target,
    identity: IDENTITY,
    token: '',
    fragment: '',
    onCancelled: (why) => void cancelled.push(why),
    effects,
    ...options,
  })

  const phases: Phase[] = []
  session.subscribe(() => phases.push(session.getState().phase))

  return {
    session,
    phases,
    cancelled,
    cached,
    remembered,
    forgotten,
    get fragmentsCleared() {
      return record.fragmentsCleared
    },
    get enginesDiscarded() {
      return record.enginesDiscarded
    },
  }
}

function savedCopy(overrides: Partial<RepositoryGraphData> = {}): CachedGraph {
  return { savedAt: new Date('2026-08-30T09:00:00Z'), data: { ...data, ...overrides } }
}

function kinds(phases: Phase[]): Phase['kind'][] {
  return phases.map((phase) => phase.kind)
}

describe('the gate a session opens on', () => {
  it('quotes the budget it read, and stops saying it is checking', async () => {
    const harness = open()
    harness.session.begin()
    expect(harness.session.getState().phase).toEqual({ kind: 'gate', status: null, checking: true })

    await settle()

    expect(harness.session.getState().phase).toEqual({
      kind: 'gate',
      status: BUDGET,
      checking: false,
    })
  })

  it('stays usable when the budget could not be read at all', async () => {
    const harness = open({ readRateLimit: async () => null })
    harness.session.begin()
    await settle()

    expect(harness.session.getState().phase).toEqual({
      kind: 'gate',
      status: null,
      checking: false,
    })
  })

  it('stays usable when reading the budget throws rather than answering', async () => {
    const harness = open({ readRateLimit: async () => Promise.reject(new Error('offline')) })
    harness.session.begin()
    await settle()

    expect(harness.session.getState().phase).toMatchObject({ kind: 'gate', checking: false })
  })

  it('ignores a budget that arrives after the session was closed', async () => {
    const held = deferred<RateLimitStatus | null>()
    const harness = open({ readRateLimit: () => held.promise })
    harness.session.begin()
    harness.session.close()

    held.resolve(BUDGET)
    await settle()

    expect(harness.session.getState().phase).toMatchObject({ checking: true })
  })
})

describe('reading the repository from GitHub', () => {
  it('walks listing, resolving, drawing and ready, and keeps what it read', async () => {
    const harness = open({
      loadRepositoryGraph: async (_target, options: LoadOptions = {}) => {
        options.onProgress?.({ done: 1, total: 3 })
        return { ok: true, data }
      },
    })
    harness.session.begin()
    await settle()
    harness.phases.length = 0

    harness.session.start(false)
    await settle()

    expect(kinds(harness.phases)).toEqual(['listing', 'resolving', 'drawing', 'ready'])
    expect(harness.session.getState().phase).toMatchObject({
      kind: 'ready',
      savedCopy: null,
      snapshot: { capturedAt: new Date('2026-08-31T12:00:00Z'), showClosed: false },
    })
    expect(harness.cached).toEqual([[IDENTITY, data]])
    expect(harness.remembered).toEqual([target])
  })

  it('reports the failure the loader named', async () => {
    const harness = open({
      loadRepositoryGraph: async () => ({ ok: false, failure: { kind: 'not-found' } }),
    })
    harness.session.start(false)
    await settle()

    expect(harness.session.getState().phase).toEqual({
      kind: 'failed',
      failure: { kind: 'not-found' },
    })
    expect(harness.cached).toEqual([])
  })

  it('rewinds rather than failing when the viewer cancelled it themselves', async () => {
    const harness = open({
      loadRepositoryGraph: async () => ({ ok: false, failure: { kind: 'cancelled' } }),
    })
    harness.session.start(false)
    await settle()

    expect(harness.cancelled).toEqual([null])
    expect(kinds(harness.phases)).not.toContain('failed')
  })

  it('calls a thrown request a network failure, carrying its message', async () => {
    const harness = open({
      loadRepositoryGraph: async () => Promise.reject(new TypeError('Failed to fetch')),
    })
    harness.session.start(false)
    await settle()

    expect(harness.session.getState().phase).toEqual({
      kind: 'failed',
      failure: { kind: 'network', message: 'Failed to fetch' },
    })
  })

  /**
   * The layout is not a request. Reporting it as one told the reader that GitHub could not be
   * reached immediately after GitHub had answered, and pointed them at the working half.
   */
  it('calls a failed layout a layout failure, not a network one', async () => {
    const harness = open({
      buildGraph: async () => Promise.reject(new Error('the worker stopped')),
    })
    harness.session.start(false)
    await settle()

    expect(harness.session.getState().phase).toEqual({
      kind: 'failed',
      failure: { kind: 'layout', message: 'the worker stopped' },
    })
  })

  it('names a layout failure even when it was thrown without a message', async () => {
    const harness = open({ buildGraph: async () => Promise.reject('nope') })
    harness.session.start(false)
    await settle()

    expect(harness.session.getState().phase).toEqual({
      kind: 'failed',
      failure: { kind: 'layout', message: 'The layout could not be computed.' },
    })
  })

  it('drops a graph laid out for a run that has since been replaced', async () => {
    const held = deferred<IssueGraph>()
    let call = 0
    const harness = open({
      buildGraph: async () => {
        call += 1
        return call === 1 ? held.promise : graph
      },
    })

    harness.session.start(false)
    await settle()
    expect(harness.session.getState().phase).toEqual({ kind: 'drawing' })

    // A second read replaces the first, whose layout is still running.
    harness.session.start(true)
    await settle()
    held.resolve({ ...graph, identity: 'stale/graph' })
    await settle()

    expect(harness.session.getState().phase).toMatchObject({
      kind: 'ready',
      graph: { identity: IDENTITY },
    })
  })
})

describe('the confirmation before dependencies are spent', () => {
  /** A loader that stops on the confirmation, so a test can act while it is pending. */
  function confirmingLoader(answers: boolean[]) {
    return async (_target: RepoTarget, options: LoadOptions = {}): Promise<LoadResult> => {
      const approved = await options.confirmDependencies?.(7)
      answers.push(approved === true)
      if (approved !== true) return { ok: false, failure: { kind: 'cancelled' } }
      return { ok: true, data }
    }
  }

  it('asks with the cost and the budget read just before it', async () => {
    const answers: boolean[] = []
    const harness = open({ loadRepositoryGraph: confirmingLoader(answers) })
    harness.session.start(false)
    await settle()

    expect(harness.session.getState().phase).toMatchObject({
      kind: 'confirm',
      cost: 7,
      status: BUDGET,
    })
  })

  it('carries an approval through to a drawn graph', async () => {
    const answers: boolean[] = []
    const harness = open({ loadRepositoryGraph: confirmingLoader(answers) })
    harness.session.start(false)
    await settle()

    const phase = harness.session.getState().phase
    if (phase.kind !== 'confirm') throw new Error(`expected a confirmation, got ${phase.kind}`)
    phase.decide(true)
    await settle()

    expect(answers).toEqual([true])
    expect(harness.session.getState().phase.kind).toBe('ready')
  })

  it('answers no, once, when the viewer declines', async () => {
    const answers: boolean[] = []
    const harness = open({ loadRepositoryGraph: confirmingLoader(answers) })
    harness.session.start(false)
    await settle()

    const phase = harness.session.getState().phase
    if (phase.kind !== 'confirm') throw new Error(`expected a confirmation, got ${phase.kind}`)
    phase.decide(false)
    phase.decide(true)
    await settle()

    expect(answers).toEqual([false])
    expect(harness.cancelled).toEqual([null])
  })

  /**
   * The defect this closes: nothing settled the promise the loader was awaiting, so a session that
   * went away left it suspended for the lifetime of the page, holding everything behind it.
   */
  it('settles what the loader is awaiting when the session closes', async () => {
    const answers: boolean[] = []
    const harness = open({ loadRepositoryGraph: confirmingLoader(answers) })
    harness.session.start(false)
    await settle()
    expect(harness.session.getState().phase.kind).toBe('confirm')

    harness.session.close()
    await settle()

    expect(answers).toEqual([false])
  })

  it('settles it when the token changes under it, and says the read was stopped', async () => {
    const answers: boolean[] = []
    const harness = open({ loadRepositoryGraph: confirmingLoader(answers) })
    harness.session.start(false)
    await settle()

    harness.session.setToken('ghp_new')
    await settle()

    expect(answers).toEqual([false])
    expect(harness.session.getState()).toMatchObject({
      phase: { kind: 'gate' },
      stopped: 'The read was stopped when the token changed. Nothing further was sent without it.',
    })
    // The cancellation belongs to the token change, which already explained itself.
    expect(harness.cancelled).toEqual([])
  })

  it('settles it when a second read replaces the one waiting', async () => {
    const answers: boolean[] = []
    const harness = open({ loadRepositoryGraph: confirmingLoader(answers) })
    harness.session.start(false)
    await settle()

    harness.session.start(true)
    await settle()

    expect(answers[0]).toBe(false)
  })
})

describe('opening the copy this browser saved', () => {
  it('draws it, and says whose copy it is', async () => {
    const copy = savedCopy()
    const harness = open({ readCache: () => copy })
    harness.session.openSavedCopy(false)
    await settle()

    expect(harness.session.getState().phase).toMatchObject({
      kind: 'ready',
      savedCopy: { source: 'saved', savedAt: copy.savedAt, includedClosed: false },
      snapshot: { capturedAt: copy.savedAt, showClosed: false },
    })
    // Nothing was read, so nothing is written back.
    expect(harness.cached).toEqual([])
  })

  it('declines a view the saved read never covered', async () => {
    const harness = open({ readCache: () => savedCopy() })
    harness.session.begin()
    await settle()
    harness.phases.length = 0

    harness.session.openSavedCopy(true)
    await settle()

    expect(harness.phases).toEqual([])
    expect(harness.session.getState().phase.kind).toBe('gate')
  })

  it('does nothing when there is no saved copy', async () => {
    const harness = open()
    harness.session.openSavedCopy(false)
    await settle()

    expect(harness.phases).toEqual([])
  })

  /**
   * The defect this closes: the cached path had no rejection handler, so a failed layout left
   * `Laying out the graph…` on screen with nothing ever coming to replace it.
   */
  it('reports a failed layout instead of drawing forever', async () => {
    const harness = open({
      readCache: () => savedCopy(),
      buildGraph: async () => Promise.reject(new Error('elk gave up')),
    })
    harness.session.openSavedCopy(false)
    await settle()

    expect(kinds(harness.phases)).toEqual(['drawing', 'failed'])
    expect(harness.session.getState().phase).toEqual({
      kind: 'failed',
      failure: { kind: 'layout', message: 'elk gave up' },
    })
  })

  /** Drawn from this browser's own store, so it sends nothing and holds no token either. */
  it('keeps drawing when the token changes', async () => {
    const held = deferred<IssueGraph>()
    const harness = open({ readCache: () => savedCopy(), buildGraph: () => held.promise })
    harness.session.openSavedCopy(false)
    await settle()

    harness.session.setToken('ghp_new')
    held.resolve(graph)
    await settle()

    expect(harness.session.getState()).toMatchObject({
      phase: { kind: 'ready', savedCopy: { source: 'saved' } },
      stopped: null,
    })
  })

  it('drops a layout that finishes after the session closed', async () => {
    const held = deferred<IssueGraph>()
    const harness = open({ readCache: () => savedCopy(), buildGraph: () => held.promise })
    harness.session.openSavedCopy(false)
    await settle()

    harness.session.close()
    held.resolve(graph)
    await settle()

    expect(kinds(harness.phases)).toEqual(['drawing'])
  })

  /**
   * Dropping the result is only half of it. ELK offers no cancellation, so a layout the session has
   * walked away from keeps running — but it runs in a worker now, and a worker can be terminated.
   */
  it('terminates the engine when it closes mid-layout', async () => {
    const held = deferred<IssueGraph>()
    const harness = open({ readCache: () => savedCopy(), buildGraph: () => held.promise })
    harness.session.openSavedCopy(false)
    await settle()

    harness.session.close()

    expect(harness.enginesDiscarded).toBe(1)
  })

  it('keeps the engine when it closes with nothing being laid out', async () => {
    const harness = open({ readCache: () => savedCopy() })
    harness.session.openSavedCopy(false)
    await settle()

    harness.session.close()

    // The layout finished before the session closed, so the engine is the next session's to reuse.
    expect(harness.enginesDiscarded).toBe(0)
  })
})

describe('a copy that could not be saved', () => {
  it('says so beside the drawn graph rather than swallowing the refusal', async () => {
    const harness = open({
      writeCache: () => ({
        ok: false,
        reason: 'quota',
        message: 'This browser\u2019s storage is full.',
      }),
    })
    harness.session.start(false)
    await settle()

    // The graph itself is fine: it was read, and it is drawn. Only the copy for next time is
    // missing, and that is what the sentence is about.
    expect(harness.session.getState().phase).toMatchObject({ kind: 'ready' })
    expect(harness.session.getState().saveProblem).toBe(
      'This browser\u2019s storage is full. This graph was not saved, so opening it again will read from GitHub.',
    )
  })

  it('says nothing when the copy was saved', async () => {
    const harness = open()
    harness.session.start(false)
    await settle()

    expect(harness.session.getState().saveProblem).toBeNull()
  })
})

describe('clearing what this browser saved', () => {
  it('removes the repository\u2019s data and stops offering the copy', async () => {
    const harness = open({ readCache: () => savedCopy() })
    harness.session.begin()
    await settle()

    expect(harness.session.cached).not.toBeNull()
    expect(harness.session.forgetSavedCopy()).toEqual({ ok: true })

    expect(harness.forgotten).toEqual([IDENTITY])
    expect(harness.session.cached).toBeNull()
  })

  it('tells its subscribers, so the page stops naming a copy that is gone', async () => {
    const harness = open({ readCache: () => savedCopy() })
    harness.session.begin()
    await settle()

    let notified = 0
    harness.session.subscribe(() => void (notified += 1))
    harness.session.forgetSavedCopy()

    expect(notified).toBe(1)
  })

  it('reports a browser that refused, rather than claiming the data is gone', async () => {
    const harness = open({
      readCache: () => savedCopy(),
      clearRepositoryData: () => ({
        ok: false,
        reason: 'unavailable',
        message: 'This browser is not letting the page save anything.',
      }),
    })
    harness.session.begin()
    await settle()

    expect(harness.session.forgetSavedCopy()).toMatchObject({ reason: 'unavailable' })
  })

  /* The copy is still there when the browser refused to remove it, and the page has to keep
     saying so. Forgetting it anyway took away the button that opens it and the button that
     retries, under a sentence saying nothing was removed: the data reappeared on the next
     reload, which was also the reader's only way back to it. */

  it('keeps offering the copy the browser would not remove', async () => {
    const harness = open({
      readCache: () => savedCopy(),
      clearRepositoryData: () => ({
        ok: false,
        reason: 'unavailable',
        message: 'This browser is not letting the page save anything.',
      }),
    })
    harness.session.begin()
    await settle()

    let notified = 0
    harness.session.subscribe(() => void (notified += 1))
    harness.session.forgetSavedCopy()

    expect(harness.session.cached).not.toBeNull()
    // Nothing changed, so nothing is published: a re-render here would only redraw the same gate.
    expect(notified).toBe(0)
  })

  it('still opens the copy after a refused removal, so retrying is not a reload', async () => {
    const copy = savedCopy()
    const harness = open({
      readCache: () => copy,
      clearRepositoryData: () => ({
        ok: false,
        reason: 'unavailable',
        message: 'This browser is not letting the page save anything.',
      }),
    })
    harness.session.begin()
    await settle()
    harness.session.forgetSavedCopy()

    harness.session.openSavedCopy(false)
    await settle()

    expect(harness.session.getState().phase).toMatchObject({
      kind: 'ready',
      savedCopy: { source: 'saved', savedAt: copy.savedAt },
    })
  })
})

describe('a shared link in the fragment', () => {
  const view: SnapshotView = {
    data,
    capturedAt: new Date('2026-08-29T08:00:00Z'),
    showClosed: true,
  }
  const fragment = '#g=whatever'

  it('draws it as somebody else’s copy, and keeps it out of this browser’s store', async () => {
    const harness = open(
      { readSnapshot: async (): Promise<SnapshotRead> => ({ kind: 'snapshot', view }) },
      { fragment },
    )
    harness.session.begin()
    await settle()

    expect(harness.session.getState().phase).toMatchObject({
      kind: 'ready',
      savedCopy: { source: 'shared', savedAt: view.capturedAt, includedClosed: true },
    })
    expect(harness.cached).toEqual([])
  })

  it('falls back to the gate with the reason a damaged link gave', async () => {
    const harness = open(
      {
        readSnapshot: async (): Promise<SnapshotRead> => ({
          kind: 'invalid',
          reason: 'This link is for another repository.',
        }),
      },
      { fragment },
    )
    harness.session.begin()
    await settle()

    expect(harness.session.getState()).toMatchObject({
      phase: { kind: 'gate', checking: false },
      linkProblem: 'This link is for another repository.',
    })
    expect(harness.fragmentsCleared).toBe(1)
  })

  it('falls back with no reason when the fragment held no snapshot after all', async () => {
    const harness = open({ readSnapshot: async (): Promise<SnapshotRead> => ({ kind: 'none' }) }, { fragment })
    harness.session.begin()
    await settle()

    expect(harness.session.getState()).toMatchObject({
      phase: { kind: 'gate' },
      linkProblem: null,
    })
  })

  it('says the link could not be read when reading it threw', async () => {
    const harness = open({ readSnapshot: async () => Promise.reject(new Error('bad base64')) }, { fragment })
    harness.session.begin()
    await settle()

    expect(harness.session.getState().linkProblem).toBe('This shared link could not be read.')
  })

  /** The link was read; the drawing is what failed, and blaming the sender for that is wrong. */
  it('separates a link that could not be drawn from one that could not be read', async () => {
    const harness = open(
      {
        readSnapshot: async (): Promise<SnapshotRead> => ({ kind: 'snapshot', view }),
        buildGraph: async () => Promise.reject(new Error('elk gave up')),
      },
      { fragment },
    )
    harness.session.begin()
    await settle()

    expect(harness.session.getState()).toMatchObject({
      phase: { kind: 'gate' },
      linkProblem: 'This shared link was read, but could not be drawn.',
    })
  })

  /**
   * A shared link sends no request and carries no credential, so a token change has nothing to
   * stop. Ending it would discard a graph that cost the viewer nothing and strand the snapshot
   * still sitting in the address bar, leaving the page and the URL describing different things.
   */
  it('keeps drawing when the token changes, because it carries neither', async () => {
    const held = deferred<SnapshotRead>()
    const harness = open({ readSnapshot: () => held.promise }, { fragment })
    harness.session.begin()
    expect(harness.session.getState().phase).toEqual({ kind: 'drawing' })

    harness.session.setToken('ghp_new')
    expect(harness.session.getState().phase).toEqual({ kind: 'drawing' })

    held.resolve({ kind: 'snapshot', view })
    await settle()

    expect(harness.session.getState()).toMatchObject({
      phase: { kind: 'ready', savedCopy: { source: 'shared' } },
      stopped: null,
    })
    expect(harness.fragmentsCleared).toBe(0)
  })

  it('keeps a layout already under way when the token changes', async () => {
    const held = deferred<IssueGraph>()
    const harness = open(
      {
        readSnapshot: async (): Promise<SnapshotRead> => ({ kind: 'snapshot', view }),
        buildGraph: () => held.promise,
      },
      { fragment },
    )
    harness.session.begin()
    await settle()
    expect(harness.session.getState().phase).toEqual({ kind: 'drawing' })

    harness.session.setToken('ghp_new')
    held.resolve(graph)
    await settle()

    expect(harness.session.getState().phase.kind).toBe('ready')
  })

  /**
   * Giving up on a link rewrites the address bar, so a run that has been ended must not reach it:
   * stripping the fragment of a page that has gone would take the snapshot with it.
   */
  it('leaves the address bar alone when the run it belonged to was ended', async () => {
    const held = deferred<SnapshotRead>()
    const harness = open({ readSnapshot: () => held.promise }, { fragment })
    harness.session.begin()

    harness.session.close()
    held.resolve({ kind: 'invalid', reason: 'This link is for another repository.' })
    await settle()

    expect(harness.fragmentsCleared).toBe(0)
    expect(harness.session.getState().linkProblem).toBeNull()
  })

  it('drops a snapshot that arrives after the session closed', async () => {
    const held = deferred<SnapshotRead>()
    const harness = open({ readSnapshot: () => held.promise }, { fragment })
    harness.session.begin()
    harness.session.close()

    held.resolve({ kind: 'snapshot', view })
    await settle()

    expect(harness.session.getState().phase).toEqual({ kind: 'drawing' })
  })
})

/**
 * A load carries the token it started with, so changing one mid-flight has to stop the other.
 * Anything that is not in flight is left alone: nothing of its is still in the air.
 */
describe('what a token change interrupts', () => {
  it('stops a read that is under way', () => {
    expect(stopsForTokenChange('listing', true)).toBe(true)
    expect(stopsForTokenChange('confirm', true)).toBe(true)
    expect(stopsForTokenChange('resolving', true)).toBe(true)
    expect(stopsForTokenChange('drawing', true)).toBe(true)
  })

  it('leaves a gate, a drawn graph, and a reported failure alone', () => {
    expect(stopsForTokenChange('gate', true)).toBe(false)
    expect(stopsForTokenChange('ready', true)).toBe(false)
    expect(stopsForTokenChange('failed', true)).toBe(false)
  })

  /**
   * The same phase covers a graph laid out from a GitHub read and one laid out from a payload
   * already in hand. Only the first is holding the token, and only it has anything to stop.
   */
  it('leaves work that never carried the token alone, in every phase', () => {
    const kinds: Phase['kind'][] = [
      'gate',
      'listing',
      'confirm',
      'resolving',
      'drawing',
      'failed',
      'ready',
    ]

    for (const kind of kinds) expect(stopsForTokenChange(kind, false)).toBe(false)
  })

  it('aborts the signal the requests in flight are carrying', async () => {
    const held = deferred<LoadResult>()
    let signal: AbortSignal | undefined
    const harness = open({
      loadRepositoryGraph: (_target, options: LoadOptions = {}) => {
        signal = options.signal
        return held.promise
      },
    })
    harness.session.start(false)
    await settle()

    harness.session.setToken('ghp_new')

    expect(signal?.aborted).toBe(true)
  })

  it('says so differently when the token was removed rather than replaced', async () => {
    const harness = open({ loadRepositoryGraph: () => deferred<LoadResult>().promise }, { token: 'ghp_old' })
    harness.session.start(false)
    await settle()

    harness.session.setToken('')

    expect(harness.session.getState().stopped).toBe(
      'The read was stopped when the token was removed. Nothing further was sent with it.',
    )
  })

  it('leaves a drawn graph on screen, because nothing of its is still in flight', async () => {
    const harness = open()
    harness.session.start(false)
    await settle()
    expect(harness.session.getState().phase.kind).toBe('ready')

    harness.session.setToken('ghp_new')

    expect(harness.session.getState()).toMatchObject({ phase: { kind: 'ready' }, stopped: null })
  })

  it('reads the budget again at a gate, because the ceiling depends on the token', async () => {
    let reads = 0
    const harness = open({
      readRateLimit: async () => {
        reads += 1
        return BUDGET
      },
    })
    harness.session.begin()
    await settle()
    expect(reads).toBe(1)

    harness.session.setToken('ghp_new')
    await settle()

    expect(reads).toBe(2)
  })

  it('does nothing at all when the token did not actually change', async () => {
    const harness = open()
    harness.session.start(false)
    await settle()
    harness.phases.length = 0

    harness.session.setToken('')

    expect(harness.phases).toEqual([])
  })
})

describe('closing and reopening a session', () => {
  it('stops a read in flight and drops its result', async () => {
    const held = deferred<LoadResult>()
    const harness = open({ loadRepositoryGraph: () => held.promise })
    harness.session.start(false)
    await settle()

    harness.session.close()
    held.resolve({ ok: true, data })
    await settle()

    expect(kinds(harness.phases)).toEqual(['listing'])
    expect(harness.cached).toEqual([])
  })

  it('refuses to start anything while it is closed', async () => {
    const harness = open({ readCache: () => savedCopy() })
    harness.session.close()

    harness.session.start(false)
    harness.session.openSavedCopy(false)
    await settle()

    expect(harness.phases).toEqual([])
  })

  /** React mounts, unmounts and mounts again under StrictMode; a session that could only be closed
   * once would come back dead. */
  it('runs again after being closed', async () => {
    const harness = open()
    harness.session.begin()
    harness.session.close()

    harness.session.begin()
    await settle()

    expect(harness.session.getState().phase).toMatchObject({ kind: 'gate', checking: false })

    harness.session.start(false)
    await settle()

    expect(harness.session.getState().phase.kind).toBe('ready')
  })
})
