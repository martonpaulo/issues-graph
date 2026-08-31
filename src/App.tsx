import {
  Background,
  BackgroundVariant,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
} from '@xyflow/react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'

import { readCache, writeCache, type CachedGraph } from './cache'
import { buildGraph, dependencyCounts, NODE_WIDTH, type IssueGraph } from './graph'
import {
  AUTHENTICATED_HOURLY_LIMIT,
  loadRepositoryGraph,
  readRateLimit,
  UNAUTHENTICATED_HOURLY_LIMIT,
  type LoadFailure,
  type UnresolvedDependency,
  type RateLimitStatus,
} from './github'
import { DependencyEdge, type DependencyEdgeType } from './DependencyEdge'
import { GroupFrame, type GroupNode } from './GroupFrame'
import { Icon } from './icons'
import { IssueCard, type IssueNode } from './IssueCard'
import { RepoInput } from './RepoInput'
import {
  canonicalSlugOf,
  parseRoute,
  pathForTarget,
  slugOf,
  titleForRoute,
  type RepoTarget,
} from './route'
import { asBoolean, asStringArray, readStored, writeStored } from './storage'
import { buildSnapshotUrl, hasSnapshot, readSnapshot, type SnapshotView } from './snapshot'
import { rememberTarget } from './suggestions'
import { readToken, writeToken } from './token'
import { describeAge, describeUntil } from './time'

const BASE = import.meta.env.BASE_URL
const NODE_TYPES = { issue: IssueCard, frame: GroupFrame }
const EDGE_TYPES = { dependency: DependencyEdge }

/**
 * How far past the outermost card panning may go. Generous enough that a card at the edge can be
 * dragged to the middle of the screen, bounded so the canvas never becomes empty space with the
 * graph nowhere in sight.
 */
const PAN_MARGIN_MIN = 900
const PAN_MARGIN_SHARE = 0.6

/** Room left around the graph when it is fitted, and how far past that zooming out may go. */
const FIT_PADDING = 120
const ZOOM_OUT_ALLOWANCE = 0.75
/** A floor under the floor: a graph too large to fit still has to be openable. */
const ABSOLUTE_MIN_ZOOM = 0.05

const SHOW_CLOSED_KEY = 'issue-graph:show-closed'
const hiddenKey = (slug: string) => `issue-graph:hidden:${slug}`

export interface SavedCopyProvenance {
  savedAt: Date
  includedClosed: boolean
  /**
   * Whose copy this is. A saved copy is the viewer's own earlier read; a shared one arrived in a
   * link and was taken by somebody else. Both are point-in-time, but only one of them is theirs,
   * and a recipient deciding whether to trust what is on screen needs to know which.
   */
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

function savedCopyCoverage(includedClosed: boolean): string {
  return includedClosed ? 'includes closed blockers' : 'open blockers only'
}

export function describeSavedCopy(
  savedCopy: SavedCopyProvenance,
  now: Date = new Date(),
): string {
  const what = savedCopy.source === 'shared' ? 'Shared copy' : 'Saved copy'
  return `${what} · ${describeAge(savedCopy.savedAt, now)} · ${savedCopyCoverage(savedCopy.includedClosed)}`
}

/* Sharing the graph ------------------------------------------------------
   The link carries the whole graph in its fragment, so the recipient draws it
   without spending a request. Every outcome says something: a link that cannot
   be built is a fact worth stating, never a button that quietly does nothing. */

export type ShareOutcome =
  | { kind: 'copied'; url: string }
  | { kind: 'manual'; url: string }
  | { kind: 'too-large'; chars: number; limit: number }
  | { kind: 'unsupported' }

export function describeShare(outcome: ShareOutcome): string {
  switch (outcome.kind) {
    case 'copied':
      return 'Link copied. It draws this graph without spending anyone\u2019s GitHub budget.'
    case 'manual':
      return 'Copy this link. It draws this graph without spending anyone\u2019s GitHub budget.'
    case 'too-large':
      return `This graph needs ${outcome.chars.toLocaleString('en')} characters, past the ${outcome.limit.toLocaleString('en')} a link can carry. Nothing was shortened.`
    case 'unsupported':
      return 'This browser cannot build a shared link.'
  }
}

/**
 * The budget as a headline and a footnote. The count is what a decision turns on; when it refills
 * only matters once it has run out, so it is written smaller and underneath.
 *
 * The quoted ceiling follows whether a token is set, because claiming 60 to a viewer who supplied
 * one would understate what they can spend by a factor of eighty.
 */
export function budgetParts(
  status: RateLimitStatus | null,
  authenticated = false,
): { main: string; sub: string } {
  if (!status) {
    const ceiling = authenticated ? AUTHENTICATED_HOURLY_LIMIT : UNAUTHENTICATED_HOURLY_LIMIT
    return { main: `${ceiling}/hour`, sub: 'current use unknown' }
  }
  return {
    main: `${status.remaining}/${status.limit} left`,
    sub: `refills ${describeUntil(status.reset)}`,
  }
}

/** A right-aligned fact: a label, its value, and a smaller note under it. */
function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="facts__row">
      <dt>{label}</dt>
      <dd>
        {value}
        {note && <small>{note}</small>}
      </dd>
    </div>
  )
}

/* External navigation ------------------------------------------------------
   Every link out of the viewer is confirmed, so a click on a card never moves
   the page somewhere the reader did not choose to go. */

interface PendingLink {
  url: string
  label: string
}

const OpenExternalContext = createContext<(url: string, label: string) => void>(() => {})

/* The viewer's token ------------------------------------------------------
   Shared the same way, because the shell, the repository field and the load
   all need it and none of them owns it. */

interface TokenState {
  token: string
  /** Stores and applies the value; blank removes it. Takes effect on the next request. */
  setToken: (value: string) => void
}

const TokenContext = createContext<TokenState>({ token: '', setToken: () => {} })

function useTokenState(): TokenState {
  return useContext(TokenContext)
}

export function useOpenExternal(): (url: string, label: string) => void {
  return useContext(OpenExternalContext)
}

function ExternalConfirm({ pending, onClose }: { pending: PendingLink; onClose: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-title"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="dialog__title" id="external-title">
          Open this on GitHub?
        </p>
        <p className="dialog__body">{pending.label}</p>
        <p className="dialog__url">
          <code>{pending.url}</code>
        </p>
        <div className="dialog__actions">
          <button
            className="button"
            type="button"
            onClick={onClose}
          >
            Stay here
          </button>
          <button
            className="button button--primary"
            type="button"
            ref={confirmRef}
            onClick={() => {
              window.open(pending.url, '_blank', 'noopener,noreferrer')
              onClose()
            }}
          >
            <Icon name="external" /> Open in a new tab
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Where a viewer supplies their own GitHub token.
 *
 * Closed by default: the page works without one, so this is an answer to a limit somebody has hit
 * rather than a step on the way in. The value is theirs — it stays in their browser, goes only to
 * api.github.com, and is never shown in plain text.
 */
function TokenField() {
  const { token, setToken } = useTokenState()
  const [draft, setDraft] = useState(token)
  const [said, setSaid] = useState<string | null>(null)
  const fieldId = useId()

  return (
    <details className="token">
      <summary className="token__summary">
        GitHub token · {token ? 'set' : `raises the limit from ${UNAUTHENTICATED_HOURLY_LIMIT} to ${AUTHENTICATED_HOURLY_LIMIT} an hour`}
      </summary>
      <div className="token__body">
        <p className="token__note">
          A fine-grained token with read access to public repositories is enough. It is kept in this
          browser only, sent only to api.github.com, and never leaves with anything else.
        </p>
        <div className="token__row">
          <label className="token__label" htmlFor={fieldId}>
            Token
          </label>
          <input
            className="token__input"
            id={fieldId}
            type="password"
            value={draft}
            placeholder={token ? '••••••••' : 'github_pat_…'}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value)
              setSaid(null)
            }}
          />
        </div>
        <div className="stage__actions">
          <button
            className="button button--primary"
            type="button"
            disabled={draft.trim() === token}
            onClick={() => {
              const stored = draft.trim()
              setToken(stored)
              // The field shows what was actually stored, which is the trimmed value.
              setDraft(stored)
              setSaid(stored ? 'Token saved. Requests from now on use it.' : 'Token removed.')
            }}
          >
            Save
          </button>
          {token && (
            <button
              className="button"
              type="button"
              onClick={() => {
                setToken('')
                setDraft('')
                setSaid('Token removed. Requests are unauthenticated again.')
              }}
            >
              Remove
            </button>
          )}
        </div>
        {said && (
          <p className="token__said" role="status">
            {said}
          </p>
        )}
      </div>
    </details>
  )
}

/* Shared shell -------------------------------------------------------------
   One page for choosing a repository and for everything that has to be said
   before its graph can be drawn. The heading and the input never move; only the
   section underneath them changes, so opening a repository reads as the same
   page continuing rather than as a jump to another screen. */

function Start({
  initial,
  onOpen,
  message,
  children,
}: {
  initial?: string
  onOpen: (target: RepoTarget) => void
  message?: string
  children?: React.ReactNode
}) {
  const { token } = useTokenState()

  return (
    <div className="centre">
      <div className="start">
        <h1 className="start__title">
          <Icon name="graph" size={20} /> Issue dependencies
        </h1>
        <p className="start__lead">
          Any public repository, from native GitHub issue relationships. Nothing is installed.
        </p>

        {message && <p className="notice notice--error">{message}</p>}

        <RepoInput initial={initial} onOpen={onOpen} token={token} />

        <TokenField />

        {children ? (
          <section className="stage">
            {/* Every fact below is about the repository the page is on, which is not necessarily
                the one being typed into the field above it. */}
            <p className="stage__for">
              <code>{initial}</code>
            </p>
            {children}
          </section>
        ) : (
          <p className="start__url">
            <code>{BASE}dependencies/owner/repo</code>
          </p>
        )}
      </div>
    </div>
  )
}

export function failureText(
  target: RepoTarget,
  failure: LoadFailure,
  authenticated = false,
): { title: string; body: string } {
  const slug = slugOf(target)
  switch (failure.kind) {
    case 'not-found':
      return {
        title: 'Nothing to read',
        body: `No public repository at ${slug}, or its issues are not readable without signing in.`,
      }
    case 'rate-limited':
      return {
        title: 'GitHub rate limit reached',
        body: authenticated
          ? `A token gets ${AUTHENTICATED_HOURLY_LIMIT} requests per hour, and this one has spent them. It refills ${describeUntil(failure.reset)}. Showing nothing rather than a misleading part of the graph.`
          : `Unauthenticated requests share ${UNAUTHENTICATED_HOURLY_LIMIT} per hour per IP address. It refills ${describeUntil(failure.reset)}. Adding a token raises that to ${AUTHENTICATED_HOURLY_LIMIT}. Showing nothing rather than a misleading part of the graph.`,
      }
    case 'bad-credentials':
      return {
        title: 'GitHub rejected the token',
        body: 'It may be expired, revoked, or mistyped. Correct it under "GitHub token" above, or remove it to read without one.',
      }
    case 'network':
      return { title: 'GitHub could not be reached', body: failure.message }
    case 'unexpected':
      // The title already carries the status, so the body must add recovery guidance rather than
      // repeat `failure.message`, which used to render as "GitHub answered 500. GitHub answered 500."
      return {
        title: failure.message,
        body: 'Nothing about the request needs changing; GitHub failed to answer it. Try again.',
      }
    case 'cancelled':
      return { title: 'Load cancelled', body: 'No dependency requests were spent.' }
  }
}

/**
 * What is missing from an incomplete graph, and why — one issue at a time.
 *
 * The loader records a separate reason per unresolved issue, and reporting only the first one told
 * the reader that a rate limit caused a 404. Identical reasons are grouped, because "#3, #7 — rate
 * limit reached" is the same fact twice; different reasons are never merged.
 */
export function describeUnresolved(unresolved: readonly UnresolvedDependency[]): string {
  if (unresolved.length === 0) return 'Some blocker data is missing, and GitHub did not say why.'

  // First appearance orders the groups, so the sentence follows the order the issues were read in.
  const groups = new Map<string, number[]>()
  for (const entry of unresolved) {
    const reason = withoutTrailingPeriod(entry.reason) || 'the request failed'
    const numbers = groups.get(reason)
    if (numbers) numbers.push(entry.number)
    else groups.set(reason, [entry.number])
  }

  const parts = [...groups.entries()].map(
    ([reason, numbers]) => `${numbers.map((number) => `#${number}`).join(', ')} — ${reason}`,
  )
  return `Some blocker data is missing: ${parts.join('; ')}.`
}

/**
 * Reasons arrive punctuated inconsistently: some are fragments the loader wrote, others are a
 * failure message that ends in a period. The sentence above supplies its own.
 */
function withoutTrailingPeriod(reason: string): string {
  return reason.trim().replace(/\.$/, '')
}

/* Canvas ------------------------------------------------------------------ */

/**
 * Picks labels out of the graph. Highlighting is additive and purely visual: it never removes a
 * card, so the shape of the dependencies stays the same while the chosen work stands out.
 */
function LabelPicker({
  labels,
  active,
  onToggle,
  onClear,
}: {
  labels: { name: string; count: number }[]
  active: ReadonlySet<string>
  onToggle: (label: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)

  if (labels.length === 0) return null

  return (
    <span className="picker">
      <button
        className={`iconbutton${active.size > 0 ? ' is-highlighting' : ''}`}
        type="button"
        aria-expanded={open}
        aria-label={
          active.size > 0
            ? `Highlighting ${active.size} label${active.size === 1 ? '' : 's'}`
            : 'Highlight the issues carrying a label'
        }
        data-tip={
          active.size > 0
            ? `Highlighting ${active.size} label${active.size === 1 ? '' : 's'}`
            : 'Highlight a label'
        }
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="tag" />
      </button>

      {open && (
        <div className="picker__panel">
          <div className="picker__head">
            <span>Highlight a label</span>
            <button
              className="iconbutton"
              type="button"
              aria-label="Close the label list"
              data-tip="Close the label list"
              onClick={() => setOpen(false)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <ul className="picker__list">
            {labels.map((label) => (
              <li key={label.name}>
                <button
                  className={`picker__item${active.has(label.name) ? ' is-on' : ''}`}
                  type="button"
                  aria-pressed={active.has(label.name)}
                  onClick={() => onToggle(label.name)}
                >
                  <span className="picker__name">{label.name}</span>
                  <span className="picker__count">{label.count}</span>
                </button>
              </li>
            ))}
          </ul>
          {active.size > 0 && (
            <button
              className="button button--small picker__clear"
              type="button"
              onClick={onClear}
            >
              Clear the highlight
            </button>
          )}
        </div>
      )}
    </span>
  )
}

export function nextIssueSelection(
  current: ReadonlySet<string>,
  id: string,
  additive: boolean,
): ReadonlySet<string> {
  if (!additive) return new Set([id])

  const next = new Set(current)
  if (!next.delete(id)) next.add(id)
  return next
}

export interface GraphBounds {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/**
 * The box every card and every group frame sits inside. One pass rather than a corner-per-array:
 * a spread of one array per corner also puts the whole node list on the call stack, which is the
 * part that stops working on a large backlog.
 */
export function graphBounds(graph: IssueGraph): GraphBounds {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity

  for (const node of graph.nodes) {
    if (node.position.x < left) left = node.position.x
    if (node.position.y < top) top = node.position.y
    if (node.position.x + NODE_WIDTH > right) right = node.position.x + NODE_WIDTH
    if (node.position.y + node.height > bottom) bottom = node.position.y + node.height
  }
  for (const group of graph.groups) {
    if (group.position.x < left) left = group.position.x
    if (group.position.y < top) top = group.position.y
    if (group.position.x + group.width > right) right = group.position.x + group.width
    if (group.position.y + group.height > bottom) bottom = group.position.y + group.height
  }

  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

/**
 * Everything the canvas needs to bound a gesture: how far a pan may travel and how far a zoom may
 * pull back. Both are read off the drawn graph and the window, so they live together.
 */
function useGraphLayout(graph: IssueGraph) {
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))

  // The zoom floor is relative to what is on screen, so it has to follow a resized window.
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /** What the drawn graph occupies, which both the pan bound and the zoom floor are built on. */
  const bounds = useMemo(() => graphBounds(graph), [graph])

  /**
   * Panning stops a screen's worth past the graph, and zooming out stops just past the point where
   * the whole graph is on screen. Both exist for the same reason: an unbounded canvas lets one
   * gesture put the graph somewhere the reader then has to hunt for.
   */
  const translateExtent = useMemo<[[number, number], [number, number]]>(() => {
    const margin = Math.max(PAN_MARGIN_MIN, Math.max(bounds.width, bounds.height) * PAN_MARGIN_SHARE)
    return [
      [bounds.left - margin, bounds.top - margin],
      [bounds.right + margin, bounds.bottom + margin],
    ]
  }, [bounds])

  const minZoom = useMemo(() => {
    const fits = Math.min(
      viewport.width / (bounds.width + FIT_PADDING),
      viewport.height / (bounds.height + FIT_PADDING),
    )
    // A little past "everything is visible", and never so far that fitView cannot reach its own
    // zoom, which would leave the graph unable to open at all.
    return Math.min(1, Math.max(ABSOLUTE_MIN_ZOOM, fits * ZOOM_OUT_ALLOWANCE))
  }, [bounds, viewport])

  return { translateExtent, minZoom }
}

function useCanvasShortcuts({
  graph,
  selected,
  setSelected,
  setHidden,
  fitView,
  openExternal,
}: {
  graph: IssueGraph
  selected: ReadonlySet<string>
  setSelected: Dispatch<SetStateAction<ReadonlySet<string>>>
  setHidden: Dispatch<SetStateAction<ReadonlySet<string>>>
  fitView: () => void
  openExternal: (url: string, label: string) => void
}) {
  /**
   * The few keys worth having on a canvas: leave a selection, take all of it, put the graph back
   * on screen, hide what is selected, and open the one issue that is.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // Never steal a key from a field or from a dialog that is waiting on an answer.
      if (target?.closest('input, textarea, [contenteditable="true"], .overlay')) return
      if (event.altKey || event.ctrlKey) return

      if (event.key === 'Escape') {
        setSelected(new Set())
        return
      }
      if (event.key.toLowerCase() === 'a' && (event.metaKey || event.shiftKey)) {
        event.preventDefault()
        setSelected(new Set(graph.nodes.map((node) => node.id)))
        return
      }
      if (event.metaKey) return

      if (event.key.toLowerCase() === 'f') {
        void fitView()
      } else if (event.key.toLowerCase() === 'h') {
        setHidden((current) => new Set([...current, ...selected]))
      } else if (event.key.toLowerCase() === 's') {
        setHidden((current) => new Set([...current].filter((id) => !selected.has(id))))
      } else if (event.key === 'Enter' && selected.size === 1) {
        const node = graph.nodes.find((candidate) => candidate.id === [...selected][0])
        if (node) openExternal(node.url, `#${node.number} · ${node.title}`)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [graph, selected, fitView, openExternal, setSelected, setHidden])
}

type TopLeftBarProps = {
  slug: string
  nodeCount: number
  dependentCount: number
  blockingCount: number
  onOpenExternal: (url: string, label: string) => void
}

function TopLeftBar({
  slug,
  nodeCount,
  dependentCount,
  blockingCount,
  onOpenExternal,
}: TopLeftBarProps) {
  return (
    <div className="bar bar--identity">
      {/* The wordmark is not worth the width here: the icon alone is the way back. */}
      <a className="iconbutton" href={BASE} data-tip="Choose another repository">
        <Icon name="graph" />
      </a>
      {/* The slug is the one piece of chrome whose width the repository decides, so it is the
          piece that gives way. The text stays whole in the DOM — the button's accessible name is
          the full slug however narrow the window is — and the hint carries it for a reader who
          only has the ellipsis. */}
      <button
        className="bar__slug"
        type="button"
        data-tip={slug}
        onClick={() => onOpenExternal(`https://github.com/${slug}`, slug)}
      >
        <span className="bar__slugtext">{slug}</span>
        <Icon name="external" size={11} />
      </button>
      <span className="bar__divider" />
      <span className="bar__counts">
        <strong>{nodeCount}</strong> issues · <strong>{dependentCount}</strong> depend on others ·{' '}
        <strong>{blockingCount}</strong> block others
      </span>
    </div>
  )
}

type TopRightBarProps = {
  labelCounts: { name: string; count: number }[]
  highlight: ReadonlySet<string>
  onToggleHighlight: (label: string) => void
  onClearHighlight: () => void
  onFitView: () => void
  onShare: () => void
  sharing: boolean
  onAskAgain: () => void
}

function TopRightBar({
  labelCounts,
  highlight,
  onToggleHighlight,
  onClearHighlight,
  onFitView,
  onShare,
  sharing,
  onAskAgain,
}: TopRightBarProps) {
  return (
    <div className="bar bar--tools">
      <LabelPicker
        labels={labelCounts}
        active={highlight}
        onToggle={onToggleHighlight}
        onClear={onClearHighlight}
      />
      <span className="bar__divider" />
      <button
        className="iconbutton"
        type="button"
        aria-label="Centre and fit the graph on screen"
        data-tip="Centre and fit · F"
        onClick={() => void onFitView()}
      >
        <Icon name="fit" />
      </button>
      <button
        className="iconbutton"
        type="button"
        disabled={sharing}
        aria-label="Copy a link that draws this graph"
        data-tip="Copy a shareable link"
        onClick={onShare}
      >
        <Icon name="link" />
      </button>
      <button className="button button--small" type="button" onClick={onAskAgain}>
        <Icon name="reload" size={12} /> Read latest from GitHub
      </button>
    </div>
  )
}

/**
 * Both top bars in one panel, because two panels pinned to opposite corners cannot see each other:
 * a repository name long enough, or a window narrow enough, and the tools slide underneath the
 * identity. Laid out in ordinary flex flow they push each other along the line and wrap when the
 * line runs out, which no breakpoint offset can promise. The strip itself lets gestures through;
 * only the bars catch them.
 */
export function TopChrome({
  identity,
  tools,
}: {
  identity: TopLeftBarProps
  tools: TopRightBarProps
}) {
  return (
    <Panel position="top-left" className="topbar">
      <TopLeftBar {...identity} />
      <TopRightBar {...tools} />
    </Panel>
  )
}

function SelectionBar({
  selectedCount,
  canHide,
  canShow,
  onHideSelected,
  onShowSelected,
  onClearSelection,
}: {
  selectedCount: number
  canHide: boolean
  canShow: boolean
  onHideSelected: () => void
  onShowSelected: () => void
  onClearSelection: () => void
}) {
  if (selectedCount === 0) return null

  return (
    <Panel position="bottom-center" className="actions">
      <span className="actions__count">{selectedCount} selected</span>
      {canHide && (
        <button
          className="iconbutton"
          type="button"
          aria-label="Hide the selected issues"
          data-tip="Hide the selected issues · H"
          onClick={onHideSelected}
        >
          <Icon name="eye-off" />
        </button>
      )}
      {canShow && (
        <button
          className="iconbutton"
          type="button"
          aria-label="Show the selected issues"
          data-tip="Show the selected issues · S"
          onClick={onShowSelected}
        >
          <Icon name="eye" />
        </button>
      )}
      <button
        className="iconbutton"
        type="button"
        aria-label="Clear the selection"
        data-tip="Clear the selection · Esc"
        onClick={onClearSelection}
      >
        <Icon name="close" />
      </button>
    </Panel>
  )
}

/**
 * The only two things the canvas says about the drawing itself: where it came from, and what it
 * could not reach. Neither is worth a panel on its own, and nothing floats here when both are
 * absent — every card already names its own state.
 */
function GraphStatus({
  graph,
  savedCopy,
}: {
  graph: IssueGraph
  savedCopy: SavedCopyProvenance | null
}) {
  if (!savedCopy && graph.complete) return null

  return (
    <Panel position="bottom-right" className="info">
      {savedCopy && (
        <div className="info__row info__row--muted">{describeSavedCopy(savedCopy)}</div>
      )}
      {!graph.complete && (
        /* One live region holding one complete sentence, so the whole gap is announced once
           rather than a fragment at a time. */
        <div className="info__warn" role="status">
          {describeUnresolved(graph.unresolved)}
          {graph.rateLimited && ` The budget ran out; it refills ${describeUntil(graph.rateLimitReset)}.`}
        </div>
      )}
    </Panel>
  )
}

/**
 * What came of pressing share.
 *
 * A dialog rather than a toast for the manual case, because the URL has to be selectable; the
 * short outcomes are announced instead, so a screen reader hears the same thing the eye sees.
 */
function ShareResult({ outcome, onClose }: { outcome: ShareOutcome; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="dialog__title" id="share-title">
          {outcome.kind === 'too-large' ? 'Too large to share as a link' : 'Shareable link'}
        </p>
        <p className="dialog__body">{describeShare(outcome)}</p>
        {outcome.kind === 'manual' && (
          <p className="dialog__url">
            <code>{outcome.url}</code>
          </p>
        )}
        <div className="dialog__actions">
          <button className="button button--primary" type="button" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function Canvas({
  graph,
  slug,
  savedCopy,
  snapshot,
  onAskAgain,
}: {
  graph: IssueGraph
  /** The repository as the reader spelled it, for the bar, the link and the accessible name. */
  slug: string
  savedCopy: SavedCopyProvenance | null
  snapshot: SnapshotView
  /** Opens the page that quotes what a fresh read costs. It never spends anything by itself. */
  onAskAgain: () => void
}) {
  const { fitView } = useReactFlow()
  const openExternal = useOpenExternal()

  // What is stored and what is sent are keyed by the repository the cards actually belong to, not
  // by the address they were reached through. The two differ after a rename, and the hidden cards
  // are recorded as node IDs qualified with the former.
  const identity = graph.identity

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(() => new Set())
  const [sharing, setSharing] = useState(false)
  const [shared, setShared] = useState<ShareOutcome | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(readStored(hiddenKey(identity), asStringArray, [])),
  )

  // Hiding is a reading aid, and it is worth keeping across a reload precisely because a reload
  // costs requests. Nothing here is ever written back to GitHub.
  useEffect(() => {
    writeStored(hiddenKey(identity), [...hidden])
  }, [identity, hidden])

  const share = useCallback(() => {
    setSharing(true)
    setShared(null)
    void buildSnapshotUrl(identity, snapshot, window.location.origin, BASE)
      .then(async (link): Promise<ShareOutcome> => {
        if (link.kind !== 'ready') return link
        try {
          await navigator.clipboard.writeText(link.url)
          return { kind: 'copied', url: link.url }
        } catch {
          // Clipboard access is refusable and is unavailable outside a secure context. Showing
          // the link is a worse experience than copying it, and a better one than a dead button.
          return { kind: 'manual', url: link.url }
        }
      })
      .catch((): ShareOutcome => ({ kind: 'unsupported' }))
      .then((outcome) => {
        setShared(outcome)
        setSharing(false)
      })
  }, [identity, snapshot])

  const selectIssue = useCallback((id: string, additive: boolean) => {
    setSelected((current) => nextIssueSelection(current, id, additive))
  }, [])

  const selectGroup = useCallback((members: string[]) => {
    setSelected((current) => {
      const whole = members.every((id) => current.has(id))
      const next = new Set(current)
      for (const id of members) {
        if (whole) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }, [])

  const toggleHidden = useCallback((id: string) => {
    setHidden((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const hideSelected = useCallback(() => {
    setHidden((current) => new Set([...current, ...selected]))
  }, [selected])

  const showSelected = useCallback(() => {
    setHidden((current) => new Set([...current].filter((id) => !selected.has(id))))
  }, [selected])

  /**
   * How many issues wait on something, and how many hold something up. Counted from the edges
   * actually drawn, so they describe this picture rather than GitHub's own summary.
   */
  const counts = useMemo(() => dependencyCounts(graph.edges), [graph])

  /** Every label in the graph, alphabetically: what the highlight picker offers. */
  const labelCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of graph.nodes) {
      for (const label of node.allLabels) counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [graph])

  const toggleHighlight = useCallback((label: string) => {
    setHighlight((current) => {
      const next = new Set(current)
      if (!next.delete(label)) next.add(label)
      return next
    })
  }, [])

  const nodes = useMemo<Node[]>(() => {
    const frames: GroupNode[] = graph.groups.map((group) => ({
      id: group.id,
      type: 'frame' as const,
      position: group.position,
      data: {
        group,
        selected: group.members.every((id) => selected.has(id)),
        onSelect: selectGroup,
      },
      style: { width: group.width, height: group.height },
      draggable: false,
      selectable: false,
      // Behind the cards and the edges, which is the only thing that makes it a frame.
      zIndex: -1,
    }))

    const cards: IssueNode[] = graph.nodes.map((node) => {
      const highlighted =
        highlight.size > 0 && node.allLabels.some((label) => highlight.has(label))
      return {
        id: node.id,
        type: 'issue' as const,
        position: node.position,
        data: {
          node,
          selected: selected.has(node.id),
          hidden: hidden.has(node.id),
          highlighted,
          faded: highlight.size > 0 && !highlighted,
          onSelect: selectIssue,
          onToggleHidden: toggleHidden,
          onOpen: openExternal,
        },
        // The height is the card's own, computed from its title, so React Flow measures and packs
        // the node exactly as the layout assumed.
        style: { width: NODE_WIDTH, height: node.height },
        draggable: false,
      }
    })

    return [...frames, ...cards]
  }, [
    graph,
    selected,
    hidden,
    highlight,
    selectGroup,
    selectIssue,
    toggleHidden,
    openExternal,
  ])

  const edges = useMemo<DependencyEdgeType[]>(
    () =>
      graph.edges.map((edge) => {
        const dimmed = hidden.has(edge.source) || hidden.has(edge.target)
        const lit = !dimmed && (selected.has(edge.source) || selected.has(edge.target))
        const hierarchy = edge.kind === 'hierarchy'
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'dependency' as const,
          data: { points: edge.points },
          // A lit edge is drawn last so it crosses over the ones it shares a channel with.
          zIndex: lit ? 5 : 0,
          className: [
            // Dashed and paler, so containment reads as a different relation before the reader
            // has looked for an arrowhead.
            hierarchy ? 'edge--hierarchy' : null,
            dimmed ? 'edge--dim' : lit ? 'edge--lit' : null,
          ]
            .filter(Boolean)
            .join(' ') || undefined,
          // No arrowhead on a hierarchy edge: an arrow is what says "this one first", and a parent
          // says nothing of the sort about its children.
          markerEnd: hierarchy
            ? undefined
            : { type: MarkerType.ArrowClosed, width: 15, height: 15 },
        }
      }),
    [graph, selected, hidden],
  )

  const { translateExtent, minZoom } = useGraphLayout(graph)
  useCanvasShortcuts({
    graph,
    selected,
    setSelected,
    setHidden,
    fitView,
    openExternal,
  })

  const selectedCount = selected.size
  // Offering "hide" for a selection that is already hidden, or the reverse, is a control that does
  // nothing when pressed. Unhiding one card needs no bar at all: the card keeps its own eye.
  const canHide = [...selected].some((id) => !hidden.has(id))
  const canShow = [...selected].some((id) => hidden.has(id))

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      fitView
      minZoom={minZoom}
      maxZoom={2}
      translateExtent={translateExtent}
      // Layout is automatic; dragging a card would only fight the controls it carries.
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      // The React Flow watermark is not part of this page's chrome; the credit is in the README.
      proOptions={{ hideAttribution: true }}
      onPaneClick={() => setSelected(new Set())}
      aria-label={`Issue dependency graph for ${slug}`}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} className="dots" />

      <TopChrome
        identity={{
          slug,
          nodeCount: graph.nodes.length,
          dependentCount: counts.dependent,
          blockingCount: counts.blocking,
          onOpenExternal: openExternal,
        }}
        tools={{
          labelCounts,
          highlight,
          onToggleHighlight: toggleHighlight,
          onClearHighlight: () => setHighlight(new Set()),
          onFitView: fitView,
          onShare: share,
          sharing,
          onAskAgain,
        }}
      />

      <SelectionBar
        selectedCount={selectedCount}
        canHide={canHide}
        canShow={canShow}
        onHideSelected={hideSelected}
        onShowSelected={showSelected}
        onClearSelection={() => setSelected(new Set())}
      />

      <GraphStatus graph={graph} savedCopy={savedCopy} />

      {/* Mounted before there is anything to say, because a live region added at the same moment
          as its text is not reliably announced. It carries no chrome while it is empty. */}
      <Panel
        position="bottom-left"
        className={shared?.kind === 'copied' ? 'said' : 'said said--quiet'}
      >
        <p role="status">{shared?.kind === 'copied' ? describeShare(shared) : ''}</p>
      </Panel>

      {shared && shared.kind !== 'copied' && (
        <ShareResult outcome={shared} onClose={() => setShared(null)} />
      )}
    </ReactFlow>
  )
}

/* Loading, budget gates, and the repository view --------------------------- */

type Phase =
  | { kind: 'gate'; status: RateLimitStatus | null; checking: boolean }
  | { kind: 'listing' }
  | { kind: 'confirm'; cost: number; status: RateLimitStatus | null; decide: (ok: boolean) => void }
  | { kind: 'resolving'; done: number; total: number }
  /** The layout runs off the main path of the load, and on a large graph it is not instant. */
  | { kind: 'drawing' }
  | { kind: 'failed'; failure: LoadFailure }
  | {
      kind: 'ready'
      graph: IssueGraph
      savedCopy: SavedCopyProvenance | null
      /** Kept beside the drawn graph because a shareable link is built from the data, not the layout. */
      snapshot: SnapshotView
    }

function GraphView({
  target,
  onOpen,
}: {
  target: RepoTarget
  onOpen: (target: RepoTarget) => void
}) {
  const [attempt, setAttempt] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [showClosed, setShowClosed] = useState(() => readStored(SHOW_CLOSED_KEY, asBoolean, false))

  useEffect(() => {
    writeStored(SHOW_CLOSED_KEY, showClosed)
  }, [showClosed])

  const reload = useCallback((why: string | null = null) => {
    // A shared link is a point-in-time copy; asking for the latest leaves it behind. Clearing the
    // fragment first means the remount below reads a plain repository URL, and that the address
    // bar stops offering a snapshot the page is no longer showing.
    if (window.location.hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    }
    setNote(why)
    setAttempt((value) => value + 1)
  }, [])

  // Remounting on the attempt is what rewinds a load back to its gate, so no effect has to reach
  // in and reset the phase by hand.
  return (
    <GraphLoad
      key={attempt}
      target={target}
      note={note}
      showClosed={showClosed}
      onShowClosed={setShowClosed}
      onReload={reload}
      onOpen={onOpen}
    />
  )
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

/**
 * Aborts whatever is in flight when the token it was started with is no longer the current one,
 * and records the token the next load will carry.
 *
 * The comparison lives in a ref rather than in state because the render-phase block below
 * synchronizes its own copy before any effect commits: an effect comparing against that state
 * would always find the two already equal and would never abort. Returns whether it aborted.
 */
export function abortOnTokenChange(
  carried: { current: string },
  token: string,
  active: { current: AbortController | null },
): boolean {
  if (carried.current === token) return false
  carried.current = token
  active.current?.abort()
  return true
}

function GraphLoad({
  target,
  note,
  showClosed,
  onShowClosed,
  onReload,
  onOpen,
}: {
  target: RepoTarget
  note: string | null
  showClosed: boolean
  onShowClosed: (value: boolean) => void
  onReload: (why?: string | null) => void
  onOpen: (target: RepoTarget) => void
}) {
  const { token } = useTokenState()
  // Two spellings of one repository, and they are not interchangeable.
  //
  // `identity` keys everything stored or matched — the saved copy, the hidden cards, the
  // repository a shared link claims to hold — because keying those on what the reader typed forks
  // one repository's state across its spellings. `slug` is what the reader typed, and it is what
  // the page says back to them: the bar, the repository link, the prefilled input, the copy.
  const identity = canonicalSlugOf(target)
  const slug = slugOf(target)
  // Read once per mount: the gate has to describe a copy that does not change under it.
  const [cached] = useState<CachedGraph | null>(() => readCache(identity))
  // Read once per mount, for the same reason as the saved copy: neither may change under the page
  // it produced. A snapshot in the fragment opens straight into the drawing, skipping the gate —
  // there is nothing to weigh, because drawing it costs nothing.
  const [fragment] = useState(() => window.location.hash)
  const sharedLink = hasSnapshot(fragment)
  const [phase, setPhase] = useState<Phase>(
    sharedLink ? { kind: 'drawing' } : { kind: 'gate', status: null, checking: true },
  )
  const [linkProblem, setLinkProblem] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  // Reading the budget costs nothing — GitHub documents /rate_limit as not counted — so the gate
  // can always open with real numbers instead of an assumption about what is left.
  //
  // The condition is the gate itself, not the address that opened the page. A shared link spends
  // nothing and so asks nothing — not even this free read, which still names api.github.com in a
  // request the recipient never chose to make — but a link that turns out to be unreadable lands
  // back here, and the gate it lands on has to be usable. Keying on the phase means every route to
  // the gate is quoted a budget; keying on the URL left the recovery path waiting forever on a
  // request that had already been declined.
  useEffect(() => {
    if (phase.kind !== 'gate') return
    const controller = new AbortController()
    void readRateLimit({ signal: controller.signal, token }).then((status) => {
      if (controller.signal.aborted) return
      setPhase((current) =>
        current.kind === 'gate' ? { ...current, status, checking: false } : current,
      )
    })
    return () => controller.abort()
    // Saving or removing a token changes the budget, so the gate has to read it again. The status
    // this sets leaves `kind` alone, so recording it cannot re-trigger the read that produced it.
  }, [target, token, phase.kind])

  useEffect(() => () => abort.current?.abort(), [])

  /**
   * Draws the shared link, or explains why it cannot and falls back to the ordinary gate.
   *
   * The snapshot is drawn at the choice the sender drew it with, which the link records for
   * exactly this reason — not at the coverage behind it, which can be wider, and not at the
   * recipient's own preference, which is about a repository they have not read. Nothing is
   * written to this browser's cache either: it is somebody else's copy, and a later visit must
   * not be offered it as this viewer's own.
   */
  useEffect(() => {
    if (!sharedLink) return
    let cancelled = false

    // A link that could not be read is not worth retrying on the next reload, and leaving it in
    // the address bar would describe a graph the page is not showing.
    const giveUp = (reason: string | null) => {
      setLinkProblem(reason)
      setPhase({ kind: 'gate', status: null, checking: true })
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    }

    void readSnapshot(fragment, identity)
      .then(async (read) => {
        if (cancelled) return
        if (read.kind !== 'snapshot') {
          giveUp(read.kind === 'invalid' ? read.reason : null)
          return
        }

        // Somebody else's link, so its payloads do not get to say which repository this is:
        // `readSnapshot` bound it to the one in the path, and that binding is the whole guarantee.
        const graph = await buildGraph(read.view.data, target, {
          showClosed: read.view.showClosed,
        })
        if (cancelled) return
        setPhase({
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
        })
      })
      .catch(() => {
        if (cancelled) return
        giveUp('This shared link could not be read.')
      })

    return () => {
      cancelled = true
    }
  }, [sharedLink, fragment, identity, target])

  /**
   * A load already in flight carries the token it started with: `LoadOptions` is built once, so
   * every request still queued would keep sending a credential the viewer has just replaced or
   * removed, and the budget on screen would describe an authentication state the load no longer
   * has. Stopping it is the only reading of "takes effect on the next request" that is true.
   */
  const carriedToken = useRef(token)
  const [shownToken, setShownToken] = useState(token)
  const [stopped, setStopped] = useState<string | null>(null)

  // What the page shows next. The abort itself is the effect below, because stopping a request is
  // a side effect and this block has to stay a pure state adjustment.
  if (shownToken !== token) {
    setShownToken(token)
    if (stopsForTokenChange(phase.kind)) {
      setPhase({ kind: 'gate', status: null, checking: true })
      setStopped(
        token
          ? 'The read was stopped when the token changed. Nothing further was sent without it.'
          : 'The read was stopped when the token was removed. Nothing further was sent with it.',
      )
    }
  }

  // Aborting is what actually stops the requests. Keyed on the token alone, and comparing against
  // a ref, so the state adjustment above cannot hide the change from it.
  useEffect(() => {
    abortOnTokenChange(carriedToken, token, abort)
  }, [token])

  const start = useCallback(
    (includeClosed: boolean) => {
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller
      carriedToken.current = token
      setStopped(null)
      setPhase({ kind: 'listing' })

      loadRepositoryGraph(target, {
        signal: controller.signal,
        token,
        includeClosed,
        onProgress: ({ done, total }) => {
          if (!controller.signal.aborted) setPhase({ kind: 'resolving', done, total })
        },
        confirmDependencies: async (cost) => {
          const status = await readRateLimit({ signal: controller.signal, token })
          if (controller.signal.aborted) return false
          return new Promise<boolean>((resolve) => {
            // Nothing has been sent yet, so an abort here answers the question with "no" rather
            // than leaving the load awaiting a decision the interface can no longer offer.
            const onAbort = () => resolve(false)
            controller.signal.addEventListener('abort', onAbort, { once: true })
            setPhase({
              kind: 'confirm',
              cost,
              status,
              decide: (ok) => {
                controller.signal.removeEventListener('abort', onAbort)
                resolve(ok)
              },
            })
          })
        },
      })
        .then(async (result) => {
          if (controller.signal.aborted) return
          if (result.ok) {
            rememberTarget(target)
            writeCache(identity, result.data)
            setPhase({ kind: 'drawing' })
            // Read from GitHub just now, so the payloads may name the repository they came from.
            const graph = await buildGraph(result.data, target, {
              showClosed: includeClosed,
              trustedIdentity: true,
            })
            if (!controller.signal.aborted) {
              setPhase({
                kind: 'ready',
                graph,
                savedCopy: null,
                snapshot: {
                  data: result.data,
                  capturedAt: new Date(),
                  showClosed: includeClosed,
                },
              })
            }
          } else if (result.failure.kind === 'cancelled') {
            onReload(null)
          } else {
            setPhase({ kind: 'failed', failure: result.failure })
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setPhase({
            kind: 'failed',
            failure: {
              kind: 'network',
              message: error instanceof Error ? error.message : 'The request failed.',
            },
          })
        })
    },
    [target, identity, token, onReload],
  )

  const drawSavedCopy = useCallback(
    (copy: CachedGraph) => {
      const decision = decideSavedCopyOpen(copy, showClosed)
      if (decision.kind !== 'open') return

      setPhase({ kind: 'drawing' })
      // This browser's own copy of a read it made from GitHub, under this repository's key.
      void buildGraph(copy.data, target, { showClosed, trustedIdentity: true }).then((graph) =>
        setPhase({
          kind: 'ready',
          graph,
          savedCopy: decision.provenance,
          snapshot: { data: copy.data, capturedAt: copy.savedAt, showClosed },
        }),
      )
    },
    [target, showClosed],
  )

  const savedCopyDecision = cached ? decideSavedCopyOpen(cached, showClosed) : null

  if (phase.kind === 'ready' && phase.graph.nodes.length > 0) {
    return (
      <ReactFlowProvider>
        <Canvas
          key={`${identity}:${showClosed}`}
          graph={phase.graph}
          slug={slug}
          savedCopy={phase.savedCopy}
          snapshot={phase.snapshot}
          onAskAgain={() => onReload()}
        />
      </ReactFlowProvider>
    )
  }

  // Everything short of a drawn graph stays on the page the repository was chosen from.
  return (
    <Start initial={slug} onOpen={onOpen}>
      {phase.kind === 'gate' && (
        <>
          {note && <p className="notice">{note}</p>}
          {linkProblem && (
            <p className="notice" role="status">
              {linkProblem} Reading {slug} from GitHub is still an option.
            </p>
          )}
          {stopped && (
            <p className="notice" role="status">
              {stopped}
            </p>
          )}
          <dl className="facts">
            <Fact
              label="Budget"
              value={phase.checking ? '…' : budgetParts(phase.status, token !== '').main}
              note={phase.checking ? undefined : budgetParts(phase.status, token !== '').sub}
            />
            {cached && (
              <Fact
                label="Saved copy"
                value={describeAge(cached.savedAt)}
                note={savedCopyCoverage(cached.data.includedClosed)}
              />
            )}
          </dl>
          <p className="stage__note">
            Reading costs GitHub requests: 1 per 100 issues, then 1 per 100 blockers of each
            blocked issue.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(event) => onShowClosed(event.target.checked)}
            />
            include closed blockers · costs more requests
          </label>
          <div className="stage__actions">
            <button
              className={savedCopyDecision?.kind === 'open' ? 'button' : 'button button--primary'}
              type="button"
              disabled={phase.checking}
              onClick={() => start(showClosed)}
            >
              <Icon name="reload" size={12} /> Fetch now
            </button>
            {cached && (
              <button
                className="button button--primary"
                type="button"
                disabled={savedCopyDecision?.kind === 'requires-latest'}
                aria-describedby={
                  savedCopyDecision?.kind === 'requires-latest'
                    ? 'saved-copy-unavailable'
                    : undefined
                }
                onClick={() => drawSavedCopy(cached)}
              >
                <Icon name="clock" size={12} /> Open saved copy
              </button>
            )}
          </div>
          {savedCopyDecision?.kind === 'requires-latest' && (
            <p className="notice" id="saved-copy-unavailable" role="status">
              {savedCopyDecision.reason}
            </p>
          )}
        </>
      )}

      {phase.kind === 'confirm' && (
        <>
          <dl className="facts">
            <Fact
              label="Budget"
              value={budgetParts(phase.status, token !== '').main}
              note={
                phase.status === null
                  ? budgetParts(phase.status, token !== '').sub
                  : `${Math.max(0, phase.status.remaining - phase.cost)} left after this`
              }
            />
          </dl>
          <p className="stage__note">
            Reading the blockers costs {phase.cost}{' '}
            {phase.cost === 1 ? 'request' : 'requests'}.
          </p>
          {phase.status !== null && phase.status.remaining < phase.cost && (
            <p className="notice notice--error">
              More than the budget has left. The graph will come back incomplete, and will say so.
            </p>
          )}
          <div className="stage__actions">
            <button
              className="button"
              type="button"
              onClick={() => phase.decide(false)}
            >
              Cancel
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={() => phase.decide(true)}
            >
              Spend {phase.cost}
            </button>
          </div>
        </>
      )}

      {(phase.kind === 'listing' || phase.kind === 'resolving' || phase.kind === 'drawing') && (
        <p className="stage__note stage__note--busy">
          {phase.kind === 'listing' && 'Listing open issues…'}
          {phase.kind === 'resolving' &&
            `Reading dependencies, ${phase.done} of ${phase.total}…`}
          {phase.kind === 'drawing' && 'Laying out the graph…'}
        </p>
      )}

      {phase.kind === 'failed' && (
        <>
          {/* One region carrying the whole message, so it is announced once and in full. */}
          <p className="notice notice--error" role="status">
            <strong>{failureText(target, phase.failure, token !== '').title}.</strong>{' '}
            {failureText(target, phase.failure, token !== '').body}
          </p>
          <div className="stage__actions">
            <button
              className="button button--primary"
              type="button"
              onClick={() => onReload()}
            >
              Try again
            </button>
          </div>
        </>
      )}

      {phase.kind === 'ready' && (
        <>
          <p className="stage__note">No open issues to draw.</p>
          <div className="stage__actions">
            <button
              className="button button--primary"
              type="button"
              onClick={() => onReload()}
            >
              Read again
            </button>
          </div>
        </>
      )}
    </Start>
  )
}

/* Router ------------------------------------------------------------------ */

export function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const [pending, setPending] = useState<PendingLink | null>(null)
  const [token, setStoredToken] = useState(() => readToken())

  // writeToken returns what was actually stored, so the state and the store cannot disagree about
  // a trimmed or blanked value.
  const setToken = useCallback((value: string) => setStoredToken(writeToken(value)), [])
  const tokenState = useMemo(() => ({ token, setToken }), [token, setToken])

  /**
   * Arriving at a shared link for the repository already on screen changes only the fragment, and
   * the browser treats that as staying on the same document: nothing reloads, and the link would
   * appear to do nothing. Counting the navigations rather than storing the fragment keeps this
   * honest — `replaceState`, which is how the page clears a fragment it has finished with, fires
   * no event, so only a real navigation remounts.
   */
  const [hashNav, setHashNav] = useState(0)

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname)
    const onHashChange = () => setHashNav((count) => count + 1)
    window.addEventListener('popstate', onPopState)
    window.addEventListener('hashchange', onHashChange)
    return () => {
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [])

  const navigate = useCallback((next: string) => {
    window.history.pushState(null, '', next)
    setPathname(next)
  }, [])

  const route = useMemo(() => parseRoute(pathname, BASE), [pathname])

  // `pathname` is updated by both `navigate` and the `popstate` listener above, so this one effect
  // covers in-app navigation, Back and Forward without a second subscription.
  useEffect(() => {
    document.title = titleForRoute(route)
  }, [route])

  const openTarget = useCallback(
    (target: RepoTarget) => navigate(pathForTarget(target, BASE)),
    [navigate],
  )
  const openExternal = useCallback((url: string, label: string) => setPending({ url, label }), [])

  return (
    <TokenContext.Provider value={tokenState}>
      <OpenExternalContext.Provider value={openExternal}>
        {route.kind === 'graph' ? (
          <GraphView
            key={`${slugOf(route.target)}:${hashNav}`}
            target={route.target}
            onOpen={openTarget}
          />
        ) : (
          <Start onOpen={openTarget} message={route.kind === 'invalid' ? route.reason : undefined} />
        )}
        {pending && <ExternalConfirm pending={pending} onClose={() => setPending(null)} />}
      </OpenExternalContext.Provider>
    </TokenContext.Provider>
  )
}
