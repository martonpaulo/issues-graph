/**
 * Everything the repository route needs and the landing route does not: the canvas, its chrome,
 * the load gate, and the copy that describes a graph.
 *
 * This module is reached only through the lazy import in `App.tsx`, so React Flow, the node and
 * edge components and the canvas stylesheet stay out of the chunk a reader downloads before they
 * have named a repository. Importing it eagerly from anywhere else undoes that split.
 */
import '@xyflow/react/dist/style.css'
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
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react'

import {
  adjacencyOf,
  dependencyRows,
  describeNode,
  issueRef,
  type DependencyRow,
} from './dependencies'
import {
  dependencyCounts,
  NODE_WIDTH,
  type GraphNode,
  type IssueGraph,
} from './graph'
import {
  AUTHENTICATED_HOURLY_LIMIT,
  UNAUTHENTICATED_HOURLY_LIMIT,
  type UnresolvedDependency,
  type RateLimitStatus,
} from './github'
import {
  browserEffects,
  decideSavedCopyOpen,
  GraphSession,
  type SavedCopyProvenance,
  type SessionFailure,
  type SessionState,
} from './graphSession'
import { DependencyEdge, type DependencyEdgeType } from './DependencyEdge'
import { GroupFrame, type GroupNode } from './GroupFrame'
import { Icon } from './icons'
import { IssueCard, STATE_TEXT, type IssueNode } from './IssueCard'
import {
  BASE,
  popupTriggerProps,
  Start,
  useModalDialog,
  useOpenExternal,
  usePopover,
  useTokenState,
} from './Shell'
import {
  canonicalSlugOf,
  slugOf,
  type RepoTarget,
} from './route'
import { dimmedKey, holdsData, releaseDimmed, saveDimmed } from './retention'
import { difference, union } from './sets'
import {
  asBoolean,
  asStringArray,
  readStored,
  writeStored,
  type StorageWriteResult,
} from './storage'
import { buildSnapshotUrl, type SnapshotView } from './snapshot'
import { describeAge, describeUntil } from './time'

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
// Re-exported because the key belongs to `retention.ts`, which owns every key one repository owns
// and is what removes them together; the canvas is only one of the two things that writes one.
export { dimmedKey }

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

/**
 * What to say once the reader has asked for this browser's copy of a repository to go.
 *
 * Naming the repository is the point: everything the viewer saves is per repository, and a reader
 * who has opened several needs to know that the others are untouched. Nothing here offers an
 * undo, because there is nothing to undo to — a copy is reconstructible by reading GitHub again,
 * which is what the button beside this one does.
 */
export function describeClear(result: StorageWriteResult, slug: string): string {
  return result.ok
    ? `Everything saved for ${slug} was removed from this browser. Other repositories are untouched.`
    : `${result.message} Nothing saved for ${slug} could be removed.`
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
export function failureText(
  target: RepoTarget,
  failure: SessionFailure,
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
    case 'layout':
      // GitHub answered; the drawing is what failed. Naming the network here sent the reader to
      // check the one thing that had already worked.
      return {
        title: 'The graph could not be laid out',
        body: `The issues of ${slug} were read, but arranging them failed: ${withoutTrailingPeriod(failure.message)}. Nothing about GitHub needs changing; try again.`,
      }
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
  const panelId = useId()
  const headingId = useId()
  const close = useCallback(() => setOpen(false), [])
  const { triggerRef, panelRef, dismiss } = usePopover(open, close)

  if (labels.length === 0) return null

  return (
    <span className="picker" data-open={open || undefined}>
      <button
        className={`iconbutton${active.size > 0 ? ' is-highlighting' : ''}`}
        type="button"
        ref={triggerRef}
        {...popupTriggerProps(open, panelId)}
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
        <div
          className="picker__panel"
          id={panelId}
          role="dialog"
          aria-labelledby={headingId}
          ref={panelRef}
        >
          <div className="picker__head">
            <span id={headingId}>Highlight a label</span>
            <button
              className="iconbutton"
              type="button"
              aria-label="Close the label list"
              data-tip="Close the label list"
              onClick={dismiss}
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

/**
 * What the table says about a blocker's state.
 *
 * Two facts, and the column needs whichever one it can get. `state` is this repository's own
 * reading of its backlog and is deliberately absent for an issue in another repository, but open
 * or closed is GitHub's and is there for every node — which is the fact this column exists for,
 * since a closed blocker is one that is no longer in the way. Naming the repository here instead
 * would answer a question the blocker's own cell already answered.
 */
export function blockerStateText(node: GraphNode): string {
  if (node.state) return STATE_TEXT[node.state]
  return node.open ? 'open' : 'closed'
}

/**
 * Every drawn edge as a row: the blocker, whether it is finished, and what it holds up.
 *
 * A real table rather than a list of sentences, because a screen reader navigates a table by row
 * and column and that is exactly the traversal a graph asks for. The blocker's state is its own
 * column so a closed blocker — which is only in the picture at all when the reader asked for
 * closed ones — is never mistaken for one still in the way.
 */
export function DependencyTable({ rows }: { rows: DependencyRow[] }) {
  return (
    <table className="deps__table">
      {/* The legend is on the caption as well as in the top bar, so the direction is stated on
          the surface a reader is actually traversing. */}
      <caption className="deps__caption">
        {rows.length} dependenc{rows.length === 1 ? 'y' : 'ies'} · {DIRECTION_LEGEND}
      </caption>
      <thead>
        <tr>
          <th scope="col">Blocker</th>
          <th scope="col">State</th>
          <th scope="col">Blocks</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <span className="deps__ref">{issueRef(row.blocker)}</span>{' '}
              <span className="deps__title">{row.blocker.title}</span>
            </td>
            <td className="deps__state">{blockerStateText(row.blocker)}</td>
            <td>
              <span className="deps__ref">{issueRef(row.dependent)}</span>{' '}
              <span className="deps__title">{row.dependent.title}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The dependencies as a table.
 *
 * The arrows carry the whole point of this page and they carry it as geometry, which leaves anyone
 * not reading the drawing with cards and no order between them. This is the same edge list the
 * canvas draws, read row by row instead of traced: one row per drawn edge, so the two surfaces
 * cannot disagree about which issue blocks which.
 *
 * Mounted only while open, because on a large backlog it is a row per edge and nobody pays for it
 * until they ask.
 */
function DependencyList({ graph }: { graph: IssueGraph }) {
  const [open, setOpen] = useState(false)
  const rows = useMemo(() => dependencyRows(graph), [graph])
  const panelId = useId()
  const headingId = useId()
  const close = useCallback(() => setOpen(false), [])
  const { triggerRef, panelRef, dismiss } = usePopover(open, close)

  if (rows.length === 0) return null

  return (
    <span className="picker" data-open={open || undefined}>
      <button
        className="iconbutton"
        type="button"
        ref={triggerRef}
        {...popupTriggerProps(open, panelId)}
        aria-label={`List the ${rows.length} dependencies as text`}
        data-tip="List the dependencies"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="list" />
      </button>

      {open && (
        <div
          className="picker__panel deps"
          id={panelId}
          role="dialog"
          aria-labelledby={headingId}
          ref={panelRef}
        >
          <div className="picker__head">
            <span id={headingId}>Dependencies</span>
            <button
              className="iconbutton"
              type="button"
              aria-label="Close the dependency list"
              data-tip="Close the dependency list"
              onClick={dismiss}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <div className="deps__scroll">
            <DependencyTable rows={rows} />
          </div>
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

/** The few keys worth having on a canvas, once it is settled that the canvas is what they meant. */
export type CanvasShortcut = 'clear' | 'select-all' | 'fit' | 'dim' | 'restore' | 'open'

/** Where the focus is, said in the two terms the shortcut table needs. */
export interface FocusPlacement {
  /** In a field, or in a dialog waiting on an answer. Nothing at all reaches the canvas. */
  captured: boolean
  /**
   * On a control the browser already activates with Enter — a card, its two icons, a link in the
   * chrome. That press belongs to the control alone.
   */
  onControl: boolean
}

/**
 * Focus inside one of these makes the key that element's, not the canvas's.
 *
 * A picker is here only while its panel is open, which is what `data-open` marks. Escape closes an
 * open panel, and without this the one press would both close it and drop the canvas selection —
 * two outcomes for a key that asked for one. A closed picker is an ordinary button on the toolbar
 * and keeps none of the canvas keys from reaching the canvas.
 *
 * Exported for the test that pins that scope: widening this back to a bare `.picker` would take
 * F, D, R and Escape away from anyone whose focus is resting on a shut toolbar control, which is
 * exactly where Escape leaves it.
 */
export const CAPTURING_FOCUS =
  'input, textarea, [contenteditable="true"], .overlay, .picker[data-open]'

/**
 * Enter activates each of these on its own. Without this list a press on a selected card's eye
 * would both dim the issue and open it on GitHub: one key, two outcomes, neither asked for.
 * https://www.w3.org/TR/WCAG22/#keyboard
 */
const ENTER_ACTIVATES = 'button, a[href], summary, select, [role="button"]'

function placeFocus(target: EventTarget | null): FocusPlacement {
  const element = target as HTMLElement | null
  return {
    captured: element?.closest(CAPTURING_FOCUS) != null,
    onControl: element?.closest(ENTER_ACTIVATES) != null,
  }
}

/**
 * What a key press asks of the canvas: leave a selection, take all of it, put the graph back on
 * screen, dim what is selected, restore it, or open the one issue that is selected.
 *
 * Pure, and separate from the effect that runs it, so the whole table — including every
 * combination the canvas must decline — is exercised without a browser.
 */
export function canvasShortcut(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  focus: FocusPlacement,
  selectionSize: number,
): CanvasShortcut | null {
  if (focus.captured) return null
  if (event.altKey || event.ctrlKey) return null

  if (event.key === 'Escape') return 'clear'
  if (event.key.toLowerCase() === 'a' && (event.metaKey || event.shiftKey)) return 'select-all'
  if (event.metaKey) return null

  switch (event.key.toLowerCase()) {
    case 'f':
      return 'fit'
    case 'd':
      return 'dim'
    case 'r':
      return 'restore'
  }

  // Enter is the one shortcut that shares its key with an activation, so it is the one that has
  // to stand down when a control has the focus.
  if (event.key === 'Enter' && selectionSize === 1 && !focus.onControl) return 'open'
  return null
}

function useCanvasShortcuts({
  graph,
  selected,
  setSelected,
  setDimmed,
  fitView,
  openExternal,
}: {
  graph: IssueGraph
  selected: ReadonlySet<string>
  setSelected: Dispatch<SetStateAction<ReadonlySet<string>>>
  setDimmed: Dispatch<SetStateAction<ReadonlySet<string>>>
  fitView: () => void
  openExternal: (url: string, label: string) => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const shortcut = canvasShortcut(event, placeFocus(event.target), selected.size)
      if (shortcut === null) return
      // The browser's own find-and-select is the only one of these it would otherwise run.
      if (shortcut === 'select-all') event.preventDefault()

      switch (shortcut) {
        case 'clear':
          setSelected(new Set())
          break
        case 'select-all':
          setSelected(new Set(graph.nodes.map((node) => node.id)))
          break
        case 'fit':
          void fitView()
          break
        case 'dim':
          setDimmed((current) => union(current, selected))
          break
        case 'restore':
          setDimmed((current) => difference(current, selected))
          break
        case 'open': {
          const node = graph.nodes.find((candidate) => candidate.id === [...selected][0])
          if (node) openExternal(node.url, `#${node.number} · ${node.title}`)
          break
        }
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [graph, selected, fitView, openExternal, setSelected, setDimmed])
}

/**
 * What an arrow means, said in words.
 *
 * The direction is the whole content of an edge — which of the two issues has to land first — and
 * an arrowhead is the only place the drawing says it. Anyone not reading the drawing needs it
 * written down, and anyone reading it for the first time benefits from the same line.
 */
export const DIRECTION_LEGEND = 'Arrow: blocker \u2192 dependent'

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
      <span className="bar__divider" />
      <span className="bar__legend">{DIRECTION_LEGEND}</span>
    </div>
  )
}

type TopRightBarProps = {
  graph: IssueGraph
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
  graph,
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
      <DependencyList graph={graph} />
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

/**
 * The selection actions. "Dim" and "Restore" name what the buttons actually do: the cards stay on
 * the canvas, keep their place in the layout and stay reachable — only their emphasis changes.
 */
export function SelectionBar({
  selectedCount,
  canDim,
  canRestore,
  onDimSelected,
  onRestoreSelected,
  onClearSelection,
}: {
  selectedCount: number
  canDim: boolean
  canRestore: boolean
  onDimSelected: () => void
  onRestoreSelected: () => void
  onClearSelection: () => void
}) {
  if (selectedCount === 0) return null

  return (
    <Panel position="bottom-center" className="actions">
      <span className="actions__count">{selectedCount} selected</span>
      {canDim && (
        <button
          className="iconbutton"
          type="button"
          aria-label="Dim the selected issues"
          data-tip="Dim the selected issues · D"
          onClick={onDimSelected}
        >
          <Icon name="eye-off" />
        </button>
      )}
      {canRestore && (
        <button
          className="iconbutton"
          type="button"
          aria-label="Restore the selected issues"
          data-tip="Restore the selected issues · R"
          onClick={onRestoreSelected}
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
  saveProblem,
}: {
  graph: IssueGraph
  savedCopy: SavedCopyProvenance | null
  saveProblem: string | null
}) {
  if (!savedCopy && !saveProblem && graph.complete) return null

  return (
    <Panel position="bottom-right" className="info">
      {savedCopy && (
        <div className="info__row info__row--muted">{describeSavedCopy(savedCopy)}</div>
      )}
      {saveProblem && (
        <div className="info__warn" role="status">
          {saveProblem}
        </div>
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
  const { dialogRef, initialRef } = useModalDialog<HTMLButtonElement>(onClose)

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        ref={dialogRef}
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
          <button className="button button--primary" type="button" ref={initialRef} onClick={onClose}>
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
  saveProblem,
  snapshot,
  onAskAgain,
}: {
  graph: IssueGraph
  /** The repository as the reader spelled it, for the bar, the link and the accessible name. */
  slug: string
  savedCopy: SavedCopyProvenance | null
  /** Why this graph could not be kept for next time, when it could not. */
  saveProblem: string | null
  snapshot: SnapshotView
  /** Opens the page that quotes what a fresh read costs. It never spends anything by itself. */
  onAskAgain: () => void
}) {
  const { fitView } = useReactFlow()
  const openExternal = useOpenExternal()

  // What is stored and what is sent are keyed by the repository the cards actually belong to, not
  // by the address they were reached through. The two differ after a rename, and the dimmed cards
  // are recorded as node IDs qualified with the former.
  const identity = graph.identity

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(() => new Set())
  const [sharing, setSharing] = useState(false)
  const [shared, setShared] = useState<ShareOutcome | null>(null)
  const [dimmed, setDimmed] = useState<ReadonlySet<string>>(
    () => new Set(readStored(dimmedKey(identity), asStringArray, [])),
  )

  // Dimming is a reading aid, and it is worth keeping across a reload precisely because a reload
  // costs requests. Nothing here is ever written back to GitHub.
  //
  // An empty set writes nothing. This effect runs on mount, so it used to create a key for every
  // repository whose graph was merely looked at — including one drawn from somebody else's shared
  // link, which deliberately saves nothing else and so left that key belonging to no budget and
  // reachable by no clear control.
  useEffect(() => {
    // Restoring the last card is not the same as never having dimmed one, but what it leaves
    // behind should be: an empty set is not a preference, so the key goes rather than being
    // written as `[]`, and a repository held by nothing else gives its retention slot back.
    if (dimmed.size === 0) {
      if (holdsData(identity)) releaseDimmed(identity)
      return
    }

    // One operation, because storing the cards and recording the repository have to hold or fail
    // together. The result is not surfaced: an unremembered preference is not worth interrupting
    // a reader over, unlike a saved graph, which costs GitHub requests to produce again.
    saveDimmed(identity, [...dimmed])
  }, [identity, dimmed])

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

  const toggleDimmed = useCallback((id: string) => {
    setDimmed((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const dimSelected = useCallback(() => {
    setDimmed((current) => union(current, selected))
  }, [selected])

  const restoreSelected = useCallback(() => {
    setDimmed((current) => difference(current, selected))
  }, [selected])

  /**
   * How many issues wait on something, and how many hold something up. Counted from the edges
   * actually drawn, so they describe this picture rather than GitHub's own summary.
   */
  const counts = useMemo(() => dependencyCounts(graph.edges), [graph])

  /**
   * What each card says about its own blockers and dependents. Derived from the drawn edges, in
   * the same pass the canvas is built from, so no card can announce a relationship the picture
   * does not show or stay silent about one it does.
   */
  const adjacency = useMemo(() => adjacencyOf(graph), [graph])

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
          dimmed: dimmed.has(node.id),
          highlighted,
          faded: highlight.size > 0 && !highlighted,
          description: describeNode(node, adjacency.get(node.id)),
          onSelect: selectIssue,
          onToggleDimmed: toggleDimmed,
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
    adjacency,
    selected,
    dimmed,
    highlight,
    selectGroup,
    selectIssue,
    toggleDimmed,
    openExternal,
  ])

  const edges = useMemo<DependencyEdgeType[]>(
    () =>
      graph.edges.map((edge) => {
        const touchesDimmed = dimmed.has(edge.source) || dimmed.has(edge.target)
        const lit = !touchesDimmed && (selected.has(edge.source) || selected.has(edge.target))
        const hierarchy = edge.kind === 'hierarchy'
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'dependency' as const,
          data: { points: edge.points, inverted: edge.inverted },
          // A lit edge is drawn last so it crosses over the ones it shares a channel with.
          zIndex: lit ? 5 : 0,
          className: [
            // Dashed and paler, so containment reads as a different relation before the reader
            // has looked for an arrowhead.
            hierarchy ? 'edge--hierarchy' : null,
            touchesDimmed ? 'edge--dim' : lit ? 'edge--lit' : null,
          ]
            .filter(Boolean)
            .join(' ') || undefined,
          // No shared arrowhead on a hierarchy edge: an arrow is what says "this one first", and a
          // parent says nothing of the sort about its children. An inverted one draws its own head
          // in the containment stroke instead, which `DependencyEdge` owns.
          markerEnd: hierarchy
            ? undefined
            : { type: MarkerType.ArrowClosed, width: 15, height: 15 },
        }
      }),
    [graph, selected, dimmed],
  )

  const { translateExtent, minZoom } = useGraphLayout(graph)
  useCanvasShortcuts({
    graph,
    selected,
    setSelected,
    setDimmed,
    fitView,
    openExternal,
  })

  const selectedCount = selected.size
  // Offering "dim" for a selection that is already dimmed, or the reverse, is a control that does
  // nothing when pressed. Restoring one card needs no bar at all: the card keeps its own eye.
  const canDim = [...selected].some((id) => !dimmed.has(id))
  const canRestore = [...selected].some((id) => dimmed.has(id))

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
      /* Each node wrapper would otherwise be a `role="group" tabindex="0"` stop wrapping the
         controls it already contains: a tab stop that looks like nothing and does nothing. The
         card's own button and its two icons are the intentional stops. */
      nodesFocusable={false}
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
          graph,
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
        canDim={canDim}
        canRestore={canRestore}
        onDimSelected={dimSelected}
        onRestoreSelected={restoreSelected}
        onClearSelection={() => setSelected(new Set())}
      />

      <GraphStatus graph={graph} savedCopy={savedCopy} saveProblem={saveProblem} />

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

export function GraphView({
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
 * Binds a {@link GraphSession} to React.
 *
 * The session is the whole lifecycle; this is subscription and nothing else, which is why it can
 * stay this short. `begin` and `close` are paired on the mount so a session that is unmounted
 * stops its requests and settles anything still waiting on an answer — and so that StrictMode's
 * mount, unmount, remount ends with a session that is running rather than one that was closed.
 */
function useGraphSession(options: {
  target: RepoTarget
  identity: string
  token: string
  onCancelled: (why: string | null) => void
}): { session: GraphSession; state: SessionState } {
  const [session] = useState(
    () =>
      new GraphSession({
        target: options.target,
        identity: options.identity,
        token: options.token,
        // Read once, for the same reason as the saved copy: neither may change under the page it
        // produced.
        fragment: window.location.hash,
        onCancelled: options.onCancelled,
        effects: browserEffects,
      }),
  )

  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState)

  useEffect(() => {
    session.begin()
    return () => session.close()
  }, [session])

  useEffect(() => {
    session.setToken(options.token)
  }, [session, options.token])

  return { session, state }
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
  // `identity` keys everything stored or matched — the saved copy, the dimmed cards, the
  // repository a shared link claims to hold — because keying those on what the reader typed forks
  // one repository's state across its spellings. `slug` is what the reader typed, and it is what
  // the page says back to them: the bar, the repository link, the prefilled input, the copy.
  const identity = canonicalSlugOf(target)
  const slug = slugOf(target)

  const { session, state } = useGraphSession({ target, identity, token, onCancelled: onReload })
  const { phase, linkProblem, stopped, saveProblem } = state
  const cached = session.cached
  const savedCopyDecision = cached ? decideSavedCopyOpen(cached, showClosed) : null
  // What became of clearing, once it has been asked for. The saved-copy row and its button
  // disappear on their own; this is the part that says so out loud, and the part that says when
  // the browser refused.
  const [cleared, setCleared] = useState<string | null>(null)
  // Offered for anything this browser holds, not only for a copy it can still read. A dimmed set
  // saved from a shared link, or a saved graph too corrupt to open, is the reader's data too, and
  // the gate is the only place they are told it exists. Re-read after clearing, which is what
  // takes the control away once there is nothing left to take.
  const hasStoredData = holdsData(identity)

  const clearSavedData = () => {
    const result = session.forgetSavedCopy()
    setCleared(describeClear(result, slug))
  }

  if (phase.kind === 'ready' && phase.graph.nodes.length > 0) {
    return (
      <ReactFlowProvider>
        <Canvas
          key={`${identity}:${showClosed}`}
          graph={phase.graph}
          slug={slug}
          savedCopy={phase.savedCopy}
          saveProblem={saveProblem}
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
            {/* Sits apart from the two buttons that open the graph, because it is the one that
                takes something away. Offered only where there is something to take away, which
                is also the only place the reader can see what they are removing. */}
            {hasStoredData && (
              <button
                className="button button--small button--aside"
                type="button"
                onClick={clearSavedData}
              >
                <Icon name="trash" size={12} /> Clear saved data
              </button>
            )}
            <button
              className={savedCopyDecision?.kind === 'open' ? 'button' : 'button button--primary'}
              type="button"
              disabled={phase.checking}
              onClick={() => session.start(showClosed)}
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
                onClick={() => session.openSavedCopy(showClosed)}
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
          {cleared && (
            <p className="notice" role="status">
              {cleared}
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

/**
 * The lazy boundary's entry point. `App.tsx` reaches this module through `React.lazy`, which
 * resolves a module's default export.
 */
export default GraphView
