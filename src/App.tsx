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
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'

import { readCache, writeCache, type CachedGraph } from './cache'
import { buildGraph, NODE_WIDTH, type IssueGraph } from './graph'
import {
  loadRepositoryGraph,
  readRateLimit,
  UNAUTHENTICATED_HOURLY_LIMIT,
  type LoadFailure,
  type RateLimitStatus,
} from './github'
import { DependencyEdge, type DependencyEdgeType } from './DependencyEdge'
import { GroupFrame, type GroupNode } from './GroupFrame'
import { Icon } from './icons'
import { IssueCard, type IssueNode } from './IssueCard'
import { RepoInput } from './RepoInput'
import { parseRoute, pathForTarget, slugOf, titleForRoute, type RepoTarget } from './route'
import { readStored, writeStored } from './storage'
import { rememberTarget } from './suggestions'
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
  return `Saved copy · ${describeAge(savedCopy.savedAt, now)} · ${savedCopyCoverage(savedCopy.includedClosed)}`
}

/**
 * The budget as a headline and a footnote. The count is what a decision turns on; when it refills
 * only matters once it has run out, so it is written smaller and underneath.
 */
function budgetParts(status: RateLimitStatus | null): { main: string; sub: string } {
  if (!status) {
    return { main: `${UNAUTHENTICATED_HOURLY_LIMIT}/hour`, sub: 'current use unknown' }
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

        <RepoInput initial={initial} onOpen={onOpen} />

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

function failureText(target: RepoTarget, failure: LoadFailure): { title: string; body: string } {
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
        body: `Unauthenticated requests share ${UNAUTHENTICATED_HOURLY_LIMIT} per hour per IP address. It refills ${describeUntil(failure.reset)}. Showing nothing rather than a misleading part of the graph.`,
      }
    case 'network':
      return { title: 'GitHub could not be reached', body: failure.message }
    case 'unexpected':
      return { title: `GitHub answered ${failure.status}`, body: failure.message }
    case 'cancelled':
      return { title: 'Load cancelled', body: 'No dependency requests were spent.' }
  }
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

function TopLeftBar({
  slug,
  nodeCount,
  dependentCount,
  blockingCount,
  onOpenExternal,
}: {
  slug: string
  nodeCount: number
  dependentCount: number
  blockingCount: number
  onOpenExternal: (url: string, label: string) => void
}) {
  return (
    <Panel position="top-left" className="bar">
      {/* The wordmark is not worth the width here: the icon alone is the way back. */}
      <a className="iconbutton" href={BASE} data-tip="Choose another repository">
        <Icon name="graph" />
      </a>
      <button
        className="bar__slug"
        type="button"
        onClick={() => onOpenExternal(`https://github.com/${slug}`, slug)}
      >
        {slug}
        <Icon name="external" size={11} />
      </button>
      <span className="bar__divider" />
      <span className="bar__counts">
        <strong>{nodeCount}</strong> issues · <strong>{dependentCount}</strong> depend on others ·{' '}
        <strong>{blockingCount}</strong> block others
      </span>
    </Panel>
  )
}

function TopRightBar({
  labelCounts,
  highlight,
  onToggleHighlight,
  onClearHighlight,
  onFitView,
  onAskAgain,
}: {
  labelCounts: { name: string; count: number }[]
  highlight: ReadonlySet<string>
  onToggleHighlight: (label: string) => void
  onClearHighlight: () => void
  onFitView: () => void
  onAskAgain: () => void
}) {
  return (
    <Panel position="top-right" className="bar bar--tools">
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
      <button className="button button--small" type="button" onClick={onAskAgain}>
        <Icon name="reload" size={12} /> Read latest from GitHub
      </button>
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
        <div className="info__warn" role="status">
          Could not read the blockers of{' '}
          {graph.unresolved.map((entry) => `#${entry.number}`).join(', ')} —{' '}
          {graph.rateLimited
            ? `the budget ran out, it refills ${describeUntil(graph.rateLimitReset)}`
            : (graph.unresolved[0]?.reason ?? 'the request failed')}
        </div>
      )}
    </Panel>
  )
}

function Canvas({
  graph,
  slug,
  savedCopy,
  onAskAgain,
}: {
  graph: IssueGraph
  slug: string
  savedCopy: SavedCopyProvenance | null
  /** Opens the page that quotes what a fresh read costs. It never spends anything by itself. */
  onAskAgain: () => void
}) {
  const { fitView } = useReactFlow()
  const openExternal = useOpenExternal()

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(() => new Set())
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(readStored<string[]>(hiddenKey(slug), [])),
  )

  // Hiding is a reading aid, and it is worth keeping across a reload precisely because a reload
  // costs requests. Nothing here is ever written back to GitHub.
  useEffect(() => {
    writeStored(hiddenKey(slug), [...hidden])
  }, [slug, hidden])

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
   * How many issues wait on something, and how many hold something up. Both are counted from the
   * edges actually drawn, so they describe this picture rather than GitHub's own summary.
   */
  const counts = useMemo(() => {
    const dependent = new Set<string>()
    const blocking = new Set<string>()
    for (const edge of graph.edges) {
      dependent.add(edge.target)
      blocking.add(edge.source)
    }
    return { dependent: dependent.size, blocking: blocking.size }
  }, [graph])

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
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'dependency' as const,
          data: { points: edge.points },
          // A lit edge is drawn last so it crosses over the ones it shares a channel with.
          zIndex: lit ? 5 : 0,
          className: dimmed ? 'edge--dim' : lit ? 'edge--lit' : undefined,
          markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
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

      <TopLeftBar
        slug={slug}
        nodeCount={graph.nodes.length}
        dependentCount={counts.dependent}
        blockingCount={counts.blocking}
        onOpenExternal={openExternal}
      />

      <TopRightBar
        labelCounts={labelCounts}
        highlight={highlight}
        onToggleHighlight={toggleHighlight}
        onClearHighlight={() => setHighlight(new Set())}
        onFitView={fitView}
        onAskAgain={onAskAgain}
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
  | { kind: 'ready'; graph: IssueGraph; savedCopy: SavedCopyProvenance | null }

function GraphView({
  target,
  onOpen,
}: {
  target: RepoTarget
  onOpen: (target: RepoTarget) => void
}) {
  const [attempt, setAttempt] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [showClosed, setShowClosed] = useState(() => readStored(SHOW_CLOSED_KEY, false))

  useEffect(() => {
    writeStored(SHOW_CLOSED_KEY, showClosed)
  }, [showClosed])

  const reload = useCallback((why: string | null = null) => {
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
  const slug = slugOf(target)
  // Read once per mount: the gate has to describe a copy that does not change under it.
  const [cached] = useState<CachedGraph | null>(() => readCache(slug))
  const [phase, setPhase] = useState<Phase>({ kind: 'gate', status: null, checking: true })
  const abort = useRef<AbortController | null>(null)

  // Reading the budget costs nothing — GitHub documents /rate_limit as not counted — so the gate
  // can always open with real numbers instead of an assumption about what is left.
  useEffect(() => {
    const controller = new AbortController()
    void readRateLimit({ signal: controller.signal }).then((status) => {
      if (controller.signal.aborted) return
      setPhase((current) =>
        current.kind === 'gate' ? { ...current, status, checking: false } : current,
      )
    })
    return () => controller.abort()
  }, [target])

  useEffect(() => () => abort.current?.abort(), [])

  const start = useCallback(
    (includeClosed: boolean) => {
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller
      setPhase({ kind: 'listing' })

      loadRepositoryGraph(target, {
        signal: controller.signal,
        includeClosed,
        onProgress: ({ done, total }) => {
          if (!controller.signal.aborted) setPhase({ kind: 'resolving', done, total })
        },
        confirmDependencies: async (cost) => {
          const status = await readRateLimit({ signal: controller.signal })
          if (controller.signal.aborted) return false
          return new Promise<boolean>((resolve) => {
            setPhase({ kind: 'confirm', cost, status, decide: resolve })
          })
        },
      })
        .then(async (result) => {
          if (controller.signal.aborted) return
          if (result.ok) {
            rememberTarget(target)
            writeCache(slug, result.data)
            setPhase({ kind: 'drawing' })
            const graph = await buildGraph(result.data, target, { showClosed: includeClosed })
            if (!controller.signal.aborted) setPhase({ kind: 'ready', graph, savedCopy: null })
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
    [target, slug, onReload],
  )

  const drawSavedCopy = useCallback(
    (copy: CachedGraph) => {
      const decision = decideSavedCopyOpen(copy, showClosed)
      if (decision.kind !== 'open') return

      setPhase({ kind: 'drawing' })
      void buildGraph(copy.data, target, { showClosed }).then((graph) =>
        setPhase({ kind: 'ready', graph, savedCopy: decision.provenance }),
      )
    },
    [target, showClosed],
  )

  const savedCopyDecision = cached ? decideSavedCopyOpen(cached, showClosed) : null

  if (phase.kind === 'ready' && phase.graph.nodes.length > 0) {
    return (
      <ReactFlowProvider>
        <Canvas
          key={`${slug}:${showClosed}`}
          graph={phase.graph}
          slug={slug}
          savedCopy={phase.savedCopy}
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
          <dl className="facts">
            <Fact
              label="Budget"
              value={phase.checking ? '…' : budgetParts(phase.status).main}
              note={phase.checking ? undefined : budgetParts(phase.status).sub}
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
            Reading costs GitHub requests: 1 per 100 issues, then 1 per issue with blockers.
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
              value={budgetParts(phase.status).main}
              note={
                phase.status === null
                  ? budgetParts(phase.status).sub
                  : `${Math.max(0, phase.status.remaining - phase.cost)} left after this`
              }
            />
          </dl>
          <p className="stage__note">
            {phase.cost} {phase.cost === 1 ? 'issue has' : 'issues have'} blockers.
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
          <p className="notice notice--error">
            <strong>{failureText(target, phase.failure).title}.</strong>{' '}
            {failureText(target, phase.failure).body}
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

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
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
    <OpenExternalContext.Provider value={openExternal}>
      {route.kind === 'graph' ? (
        <GraphView key={slugOf(route.target)} target={route.target} onOpen={openTarget} />
      ) : (
        <Start onOpen={openTarget} message={route.kind === 'invalid' ? route.reason : undefined} />
      )}
      {pending && <ExternalConfirm pending={pending} onClose={() => setPending(null)} />}
    </OpenExternalContext.Provider>
  )
}
