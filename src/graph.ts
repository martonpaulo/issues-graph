import dagre from '@dagrejs/dagre'

import type { IssuePayload, RepositoryGraphData, UnresolvedDependency } from './github'
import { cardLabels, hasNamespace, type ParsedLabel } from './labels'
import type { RepoTarget } from './route'

/**
 * Turns GitHub's payloads into a laid-out graph. Pure: no network, no React, no DOM. Every
 * dependency edge here comes from a native `blocked_by` relationship — issue prose is never read,
 * so a body claiming "depends on #123" cannot invent an edge.
 */

/** Every card is the same width; the height follows its title. */
export const NODE_WIDTH = 232

/**
 * A card is as tall as its title needs, between one line and five, and no taller.
 *
 * Uniform cards waste a column of empty space on short titles and truncate long ones at the same
 * time. The count is estimated from the text rather than measured, because this module is pure and
 * has to produce the same layout in a test as in a browser; the estimate is deliberately generous,
 * since a line too many only adds slack while a line too few would clip the title.
 */
export const MAX_TITLE_LINES = 5
const TITLE_LINE_HEIGHT = 17
/** Characters that fit on one line at 232px wide, 12.5px Inter, minus the card's padding. */
const TITLE_CHARS_PER_LINE = 33
/** Border, padding, the number/state row, and the gap under it. Mirrors `.card` in styles.css. */
const CARD_CHROME = 38
/** Comfortable gap under the title, plus the row of label chips. */
const LABELS_BLOCK = 28

export function titleLineCount(title: string, perLine = TITLE_CHARS_PER_LINE): number {
  const words = title.trim().split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 0) return 1

  let lines = 1
  let used = 0
  for (const word of words) {
    const needed = used === 0 ? word.length : used + 1 + word.length
    if (used > 0 && needed > perLine) {
      lines += 1
      used = word.length
    } else {
      used = needed
    }
    // A single word longer than the line wraps inside itself.
    while (used > perLine) {
      lines += 1
      used -= perLine
    }
  }

  return Math.min(MAX_TITLE_LINES, Math.max(1, lines))
}

export function cardHeight(titleLines: number, hasLabels: boolean): number {
  return CARD_CHROME + titleLines * TITLE_LINE_HEIGHT + (hasLabels ? LABELS_BLOCK : 0)
}

/** The tallest a card can get, which is what a bounding estimate has to assume. */
export const MAX_NODE_HEIGHT = cardHeight(MAX_TITLE_LINES, true)

export type IssueState = 'ready' | 'blocked' | 'attention' | 'completed' | 'not-planned'

export interface GraphNode {
  id: string
  number: number
  title: string
  url: string
  repo: string
  state: IssueState
  /** True when the issue lives in another repository and was reached as a blocker. */
  external: boolean
  /**
   * How that other repository is named on the card: the bare repository when the owner is the one
   * being viewed, the full `owner/repo` when it is somebody else's. Empty for a local issue.
   */
  repoLabel: string
  /** The few labels the card has room to show. */
  labels: ParsedLabel[]
  /** Every label on the issue, which is what the highlight picker offers. */
  allLabels: string[]
  /** Lines the title is allowed, and the height that leaves the card. */
  titleLines: number
  height: number
  position: { x: number; y: number }
}

export interface GraphEdge {
  id: string
  /** The blocker: it has to land first. */
  source: string
  target: string
  /**
   * The y this edge runs its horizontal leg along, for an edge between neighbouring rows. Every
   * edge arriving at one row would otherwise turn at the same height, and a dozen of them merge
   * into a single line nobody can follow back to its blocker.
   */
  centerY?: number
  /**
   * The waypoints dagre reserved for an edge that spans more than one rank. Following them is what
   * keeps such an edge from cutting through the cards it passes.
   */
  points?: Point[]
}

/**
 * A frame drawn behind a set of cards.
 *
 * `chain` is one weakly-connected set of dependencies: work that has to be finished as a unit, in
 * the order the arrows give. `free` is everything with no dependency at all, which can be picked
 * up in any order.
 */
export interface GraphGroup {
  id: string
  kind: 'chain' | 'free'
  label: string
  members: string[]
  position: { x: number; y: number }
  width: number
  height: number
}

export interface IssueGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  groups: GraphGroup[]
  /** False when any dependency could not be read. The canvas must say so rather than imply whole. */
  complete: boolean
  unresolved: UnresolvedDependency[]
  rateLimited: boolean
  rateLimitReset: Date | null
  requestCount: number
}

/** `https://api.github.com/repos/owner/name` -> `owner/name`. */
export function repoOf(repositoryUrl: string): string {
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(repositoryUrl)
  return match ? match[1] : 'unknown/unknown'
}

export function nodeId(repo: string, number: number): string {
  return `${repo}#${number}`
}

export function isOpen(issue: IssuePayload): boolean {
  return issue.state !== 'closed'
}

/**
 * State comes from GitHub, never from inference.
 *
 * `blocked_by` counts blockers that are still **open**, while `total_blocked_by` counts open and
 * closed ones. So `blocked_by > 0` is exactly "has an unfinished blocker", and an issue whose
 * blockers have all closed reads as ready even though its total stays non-zero.
 */
export function deriveState(issue: IssuePayload): IssueState {
  if (issue.state === 'closed') {
    return issue.state_reason === 'not_planned' ? 'not-planned' : 'completed'
  }
  if (hasNamespace(issue.labels, 'status')) return 'attention'
  return (issue.issue_dependencies_summary?.blocked_by ?? 0) > 0 ? 'blocked' : 'ready'
}

function toNode(issue: IssuePayload, target: RepoTarget): GraphNode {
  const repo = repoOf(issue.repository_url)
  const external = repo !== `${target.owner}/${target.repo}`
  const [owner, name] = repo.split('/')
  const repoLabel = external ? (owner === target.owner ? name : repo) : ''
  const labels = cardLabels(issue.labels)
  const titleLines = titleLineCount(issue.title)
  return {
    id: nodeId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    repo,
    state: deriveState(issue),
    external,
    repoLabel,
    labels,
    allLabels: issue.labels.map((label) => label.name),
    titleLines,
    // An external card always spends the chip row: it has to name the repository it came from.
    height: cardHeight(titleLines, labels.length > 0 || external),
    position: { x: 0, y: 0 },
  }
}

/** Space between cards in the grid, and between packed components. */
const GRID_GAP = 20
const COMPONENT_GAP = 76

/** Breathing room inside a group frame, and the strip its label sits in above the cards. */
export const GROUP_PADDING = 14
export const GROUP_LABEL_HEIGHT = 24

/** Roughly 16:9. Layout aims for this so the whole graph fits a screen after fit-to-view. */
const TARGET_ASPECT = 1.9

export interface Point {
  x: number
  y: number
}

interface Box {
  width: number
  height: number
  positions: Map<string, Point>
  /** dagre's own route for an edge, when its ranking was kept. Empty when the ranks were wrapped. */
  points: Map<string, Point[]>
}

/** Weakly-connected components: edge direction does not matter for grouping. */
function componentsOf(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[][] {
  const parent = new Map<string, string>(nodes.map((node) => [node.id, node.id]))

  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    while (parent.get(id) !== root) {
      const next = parent.get(id)!
      parent.set(id, root)
      id = next
    }
    return root
  }

  for (const edge of edges) {
    const a = find(edge.source)
    const b = find(edge.target)
    if (a !== b) parent.set(a, b)
  }

  const groups = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    const root = find(node.id)
    const group = groups.get(root)
    if (group) group.push(node)
    else groups.set(root, [node])
  }
  return [...groups.values()]
}

/**
 * Wide enough to hold a stack of horizontal edge channels between two rows. Generous on purpose:
 * a row that eight edges arrive at needs eight lines far enough apart to be told apart.
 */
const RANK_GAP = 108
const SUBROW_GAP = 22

/** Clearance kept between a card and the nearest edge channel. */
const CHANNEL_INSET = 14
/** Beyond this the channels are too close together to tell apart, so they repeat. */
const MAX_CHANNELS = 7

/**
 * Ranks one component with dagre and keeps its answer whenever it fits.
 *
 * dagre does two things worth keeping: it places each node near the ones it connects to, and it
 * routes an edge that spans several ranks around the cards between them rather than through them.
 * Rebuilding the ranks on an even grid throws both away — every edge then travels the full width
 * of the block and crosses whatever is in the way.
 *
 * The grid is only worth it when a rank is too wide to show: one martonpaulo/tabelo component fans
 * 31 issues off their blockers, nearly 8000px across. Only then is the rank wrapped into sub-rows,
 * which keeps blockers above what they block at the cost of dagre's routing.
 */
function layoutComponent(nodes: GraphNode[], edges: GraphEdge[], maxWidth: number): Box {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', ranksep: RANK_GAP, nodesep: 26, edgesep: 18, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))

  const ids = new Set(nodes.map((node) => node.id))
  const own = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  for (const node of nodes) g.setNode(node.id, { width: NODE_WIDTH, height: node.height })
  for (const edge of own) g.setEdge(edge.source, edge.target)

  dagre.layout(g)

  const laidOut = nodes.map((node) => ({ node, laid: g.node(node.id) }))
  const left = Math.min(...laidOut.map(({ laid }) => (laid?.x ?? 0) - NODE_WIDTH / 2))
  const right = Math.max(...laidOut.map(({ laid }) => (laid?.x ?? 0) + NODE_WIDTH / 2))
  const top = Math.min(...laidOut.map(({ node, laid }) => (laid?.y ?? 0) - node.height / 2))
  const bottom = Math.max(...laidOut.map(({ node, laid }) => (laid?.y ?? 0) + node.height / 2))

  if (right - left <= maxWidth) {
    const positions = new Map<string, Point>()
    for (const { node, laid } of laidOut) {
      positions.set(node.id, {
        x: (laid?.x ?? 0) - NODE_WIDTH / 2 - left,
        y: (laid?.y ?? 0) - node.height / 2 - top,
      })
    }

    const points = new Map<string, Point[]>()
    for (const edge of own) {
      const route = g.edge(edge.source, edge.target)?.points
      if (route && route.length > 0) {
        points.set(
          edge.id,
          route.map((point: Point) => ({ x: point.x - left, y: point.y - top })),
        )
      }
    }

    return { width: right - left, height: bottom - top, positions, points }
  }

  return wrapRanks(laidOut, maxWidth)
}

/**
 * The fallback for a component too wide to show: keep dagre's ranking and its left-to-right order
 * inside each rank, but fold every rank that does not fit into sub-rows.
 */
function wrapRanks(
  laidOut: { node: GraphNode; laid: { x?: number; y?: number } | undefined }[],
  maxWidth: number,
): Box {
  const ranks = new Map<number, { id: string; x: number; height: number }[]>()
  for (const { node, laid } of laidOut) {
    const rank = Math.round(laid?.y ?? 0)
    const entry = { id: node.id, x: laid?.x ?? 0, height: node.height }
    const row = ranks.get(rank)
    if (row) row.push(entry)
    else ranks.set(rank, [entry])
  }

  const columns = Math.max(1, Math.floor((maxWidth + 24) / (NODE_WIDTH + 24)))
  const positions = new Map<string, Point>()
  let cursorY = 0
  let width = 0

  for (const rank of [...ranks.keys()].sort((a, b) => a - b)) {
    const row = ranks.get(rank)!.sort((a, b) => a.x - b.x)
    const perRow = Math.min(columns, row.length)
    let y = cursorY

    for (let start = 0; start < row.length; start += perRow) {
      const sub = row.slice(start, start + perRow)
      // Centre each sub-row so a wrapped fan still reads as one group under its blocker.
      const rowWidth = sub.length * NODE_WIDTH + (sub.length - 1) * 24
      const offset = (perRow * NODE_WIDTH + (perRow - 1) * 24 - rowWidth) / 2
      let tallest = 0

      sub.forEach((entry, index) => {
        const x = offset + index * (NODE_WIDTH + 24)
        positions.set(entry.id, { x, y })
        width = Math.max(width, x + NODE_WIDTH)
        tallest = Math.max(tallest, entry.height)
      })

      y += tallest + SUBROW_GAP
    }

    cursorY = y - SUBROW_GAP + RANK_GAP
  }

  return { width, height: Math.max(0, cursorY - RANK_GAP), positions, points: new Map() }
}

/**
 * Packs every dependency-free issue into one block instead of one very long rank.
 *
 * Cards vary in height, so this fills the shortest column each time rather than laying out a rigid
 * grid: a strict grid would leave a ragged gap under every short card in a row.
 */
function gridBox(nodes: GraphNode[], columns: number): Box {
  const used = Math.max(1, Math.min(columns, nodes.length))
  const columnHeights = new Array<number>(used).fill(0)
  const positions = new Map<string, { x: number; y: number }>()

  for (const node of nodes) {
    let column = 0
    for (let index = 1; index < used; index += 1) {
      if (columnHeights[index] < columnHeights[column]) column = index
    }
    positions.set(node.id, {
      x: column * (NODE_WIDTH + GRID_GAP),
      y: columnHeights[column],
    })
    columnHeights[column] += node.height + GRID_GAP
  }

  return {
    width: used * NODE_WIDTH + (used - 1) * GRID_GAP,
    height: Math.max(0, Math.max(...columnHeights) - GRID_GAP),
    positions,
    points: new Map(),
  }
}

function groupLabel(kind: GraphGroup['kind'], count: number): string {
  const issues = `${count} issue${count === 1 ? '' : 's'}`
  // The two frames mean opposite things, so each says which it is rather than leaving the reader
  // to infer it from a border style.
  return kind === 'chain'
    ? `Chain · ${issues}, one order`
    : `Independent · ${issues}, any order`
}

export interface Layout {
  nodes: GraphNode[]
  groups: GraphGroup[]
  /** Edge id to the route the layout chose for it, when it has one. */
  routes: Map<string, Point[]>
}

/**
 * Lays the graph out as packed components rather than as one dagre run, and frames each one.
 *
 * dagre places every weakly-connected component on the same rank line, so a backlog of many small
 * independent chains opens as one enormous row: martonpaulo/tabelo measured 10112x592, an aspect of
 * 17:1, with 31 cards on a single rank. Ranking each component on its own and then shelf-packing
 * the results turns the same graph into something close to a screen shape, and every dependency
 * chain stays intact and readable inside its own block.
 *
 * The frames are the answer to "what can be picked up together": one frame is one connected piece
 * of work, and the last frame holds everything that depends on nothing.
 */
export function layout(nodes: GraphNode[], edges: GraphEdge[]): Layout {
  if (nodes.length === 0) return { nodes, groups: [], routes: new Map() }

  const components = componentsOf(nodes, edges)
  const structured = components.filter((group) => group.length > 1)
  const singles = components.filter((group) => group.length === 1).flat()

  // First pass: how big is each component when nothing is wrapped? A deep chain is naturally tall
  // and a wide fan naturally broad, and a target guessed from the node count alone gets both wrong.
  const natural = structured.map((group) => layoutComponent(group, edges, Infinity))
  const naturalArea = natural.reduce((sum, box) => sum + box.width * box.height, 0)
  const singlesArea = singles.reduce(
    (sum, node) => sum + (NODE_WIDTH + GRID_GAP) * (node.height + GRID_GAP),
    0,
  )
  const target = Math.max(
    NODE_WIDTH * 4,
    Math.sqrt(Math.max(naturalArea + singlesArea, 1) * TARGET_ASPECT),
  )

  // Second pass: re-rank anything wider than the target so it folds into the canvas shape.
  const boxes = structured
    .map((group, index) => ({
      group,
      box: natural[index].width <= target ? natural[index] : layoutComponent(group, edges, target),
    }))
    .sort((a, b) => b.group.length - a.group.length || b.box.height - a.box.height)

  const placed = new Map<string, Point>()
  const routes = new Map<string, Point[]>()
  const groups: GraphGroup[] = []
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0

  const place = (box: Box, members: GraphNode[], kind: GraphGroup['kind']) => {
    if (cursorX > 0 && cursorX + box.width > target) {
      cursorX = 0
      cursorY += rowHeight + COMPONENT_GAP
      rowHeight = 0
    }
    for (const [id, position] of box.positions) {
      placed.set(id, { x: cursorX + position.x, y: cursorY + position.y })
    }
    for (const [id, route] of box.points) {
      routes.set(
        id,
        route.map((point) => ({ x: cursorX + point.x, y: cursorY + point.y })),
      )
    }

    // The frame is measured from where the cards actually landed, so a ragged block is enclosed
    // exactly rather than by the box the packer reserved for it.
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const node of members) {
      const position = placed.get(node.id)!
      left = Math.min(left, position.x)
      top = Math.min(top, position.y)
      right = Math.max(right, position.x + NODE_WIDTH)
      bottom = Math.max(bottom, position.y + node.height)
    }

    const ids = members.map((node) => node.id).sort()
    groups.push({
      id: `group:${ids[0]}`,
      kind,
      label: groupLabel(kind, members.length),
      members: ids,
      position: { x: left - GROUP_PADDING, y: top - GROUP_PADDING - GROUP_LABEL_HEIGHT },
      width: right - left + GROUP_PADDING * 2,
      height: bottom - top + GROUP_PADDING * 2 + GROUP_LABEL_HEIGHT,
    })

    cursorX += box.width + COMPONENT_GAP
    rowHeight = Math.max(rowHeight, box.height)
  }

  for (const { box, group } of boxes) place(box, group, 'chain')

  if (singles.length > 0) {
    const columns = Math.max(1, Math.floor((target + GRID_GAP) / (NODE_WIDTH + GRID_GAP)))
    // The dependency-free block starts its own row, so it reads as a separate group.
    if (cursorX > 0) {
      cursorX = 0
      cursorY += rowHeight + COMPONENT_GAP
      rowHeight = 0
    }
    place(gridBox(singles, columns), singles, 'free')
  }

  return {
    nodes: nodes.map((node) => ({ ...node, position: placed.get(node.id) ?? node.position })),
    groups,
    routes,
  }
}

export interface BuildOptions {
  /**
   * Draws closed blockers and the edges into them. Off by default: a finished blocker no longer
   * blocks, so the issue it used to block belongs with the work that is ready to start, and a
   * backlog reads as what is left to do rather than as what has already happened.
   */
  showClosed?: boolean
}

/**
 * Gives each edge its own horizontal channel in the gap above the row it arrives at.
 *
 * `smoothstep` turns at the midpoint between the two cards, so every edge into one row shares a
 * single line. Spreading them across the gap keeps each one traceable, and ordering by span puts
 * the long travellers furthest from the cards they pass.
 */
export function routeEdges(
  nodes: GraphNode[],
  edges: GraphEdge[],
  routes: Map<string, Point[]> = new Map(),
): GraphEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const bands = new Map<number, GraphEdge[]>()

  for (const edge of edges) {
    const target = byId.get(edge.target)
    // An edge dagre routed already has its waypoints; only the rest need a channel.
    if (!target || (routes.get(edge.id)?.length ?? 0) > 2) continue
    const key = Math.round(target.position.y)
    const band = bands.get(key)
    if (band) band.push(edge)
    else bands.set(key, [edge])
  }

  const centres = new Map<string, number>()

  for (const [targetTop, band] of bands) {
    let highest = -Infinity
    for (const edge of band) {
      const source = byId.get(edge.source)
      if (source) highest = Math.max(highest, source.position.y + source.height)
    }

    const top = highest + CHANNEL_INSET
    const bottom = targetTop - CHANNEL_INSET
    if (!Number.isFinite(top) || bottom <= top) continue

    const span = (edge: GraphEdge) => {
      const source = byId.get(edge.source)
      const target = byId.get(edge.target)
      if (!source || !target) return 0
      return Math.abs(source.position.x - target.position.x)
    }

    // Longest first, so a wide run takes the channel furthest from the row it arrives at.
    const ordered = [...band].sort((a, b) => span(b) - span(a) || a.id.localeCompare(b.id))
    const channels = Math.min(MAX_CHANNELS, ordered.length)
    const step = (bottom - top) / (channels + 1)

    ordered.forEach((edge, index) => {
      centres.set(edge.id, top + ((index % channels) + 1) * step)
    })
  }

  return edges.map((edge) => {
    const route = routes.get(edge.id)
    if (route && route.length > 2) return { ...edge, points: route }
    return centres.has(edge.id) ? { ...edge, centerY: centres.get(edge.id) } : edge
  })
}

export function buildGraph(
  data: RepositoryGraphData,
  target: RepoTarget,
  options: BuildOptions = {},
): IssueGraph {
  const showClosed = options.showClosed === true
  const nodes = new Map<string, GraphNode>()
  // The list is of open issues; this guards the invariant rather than expecting to drop anything.
  for (const issue of data.issues) {
    if (!isOpen(issue)) continue
    const node = toNode(issue, target)
    nodes.set(node.id, node)
  }

  const edges: GraphEdge[] = []
  const seen = new Set<string>()

  for (const [number, blockers] of data.blockers) {
    const targetId = nodeId(`${target.owner}/${target.repo}`, number)
    if (!nodes.has(targetId)) continue

    for (const blocker of blockers) {
      if (!showClosed && !isOpen(blocker)) continue

      // A blocker in another repository is not in the issue list, so it joins the graph here.
      const blockerNode = toNode(blocker, target)
      if (!nodes.has(blockerNode.id)) nodes.set(blockerNode.id, blockerNode)

      const id = `${blockerNode.id}->${targetId}`
      if (seen.has(id)) continue
      seen.add(id)
      edges.push({ id, source: blockerNode.id, target: targetId })
    }
  }

  const laid = layout([...nodes.values()], edges)

  return {
    nodes: laid.nodes,
    edges: routeEdges(laid.nodes, edges, laid.routes),
    groups: laid.groups,
    complete: data.complete,
    unresolved: data.unresolved,
    rateLimited: data.rateLimited,
    rateLimitReset: data.rateLimitReset,
    requestCount: data.requestCount,
  }
}
