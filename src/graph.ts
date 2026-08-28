import type { IssuePayload, RepositoryGraphData, UnresolvedDependency } from './github'
import { cardLabels, chipText, hasNamespace, type CardChip } from './labels'
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
/** Comfortable gap between the title and the chips under it. */
const LABELS_GAP = 11
/** One row of label chips, and the space between two rows. */
const CHIP_ROW_HEIGHT = 17
const CHIP_GAP = 4
/**
 * Per-character width of chip text at 10px Inter, plus the chip's own padding and border. Measured
 * from the rendered cards: the real average is 4.2–4.5, and the extra is headroom, since a row too
 * many only leaves a gap while a row too few would push the chips out of the card.
 */
const CHIP_CHAR_WIDTH = 4.6
const CHIP_PADDING = 12
/** The width the chips wrap inside: the card minus its padding. */
const CHIP_ROW_WIDTH = 210

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

/**
 * How many rows a card's chips wrap onto. Estimated from the text for the same reason the title's
 * lines are: this module is pure, and the layout has to agree with what the browser will draw.
 */
export function chipRows(texts: string[], width = CHIP_ROW_WIDTH): number {
  if (texts.length === 0) return 0

  let rows = 1
  let used = 0
  for (const text of texts) {
    const chip = Math.min(width, text.length * CHIP_CHAR_WIDTH + CHIP_PADDING)
    const needed = used === 0 ? chip : used + CHIP_GAP + chip
    if (used > 0 && needed > width) {
      rows += 1
      used = chip
    } else {
      used = needed
    }
  }
  return rows
}

export function cardHeight(titleLines: number, rows: number): number {
  const chips = rows > 0 ? LABELS_GAP + rows * CHIP_ROW_HEIGHT + (rows - 1) * CHIP_GAP : 0
  return CARD_CHROME + titleLines * TITLE_LINE_HEIGHT + chips
}

/** The tallest a card is expected to get, which is what a bounding estimate has to assume. */
export const MAX_NODE_HEIGHT = cardHeight(MAX_TITLE_LINES, 2)

export type IssueState = 'ready' | 'blocked' | 'attention' | 'completed' | 'not-planned'

export interface GraphNode {
  id: string
  number: number
  title: string
  url: string
  repo: string
  /** Local workflow presentation state. External repositories do not share this convention. */
  state: IssueState | null
  /** True when the issue lives in another repository and was reached as a blocker. */
  external: boolean
  /**
   * How that other repository is named on the card: the bare repository when the owner is the one
   * being viewed, the full `owner/repo` when it is somebody else's. Empty for a local issue.
   */
  repoLabel: string
  /** The slots the card shows, filled or not. External cards show none. */
  labels: CardChip[]
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
  /** The orthogonal route the layout reserved for this edge, in canvas coordinates. */
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
  const state = external ? null : deriveState(issue)
  const labels = external ? [] : cardLabels(issue.labels)
  const titleLines = titleLineCount(issue.title)
  const rows = chipRows(labels.map(chipText))
  return {
    id: nodeId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    repo,
    state,
    external,
    repoLabel,
    labels,
    allLabels: issue.labels.map((label) => label.name),
    titleLines,
    height: cardHeight(titleLines, rows),
    position: { x: 0, y: 0 },
  }
}

/** Space between cards in the block of issues that depend on nothing. */
const GRID_GAP = 20
/** Space between that block and the drawn dependencies above it. */
const BLOCK_GAP = 80

/** Breathing room inside a group frame, and the strip its label sits in above the cards. */
export const GROUP_PADDING = 14
export const GROUP_LABEL_HEIGHT = 24

/** Roughly 16:9, so a whole graph lands on a screen after fit-to-view. */
const TARGET_ASPECT = 1.9

export interface Point {
  x: number
  y: number
}

/**
 * How the dependencies are drawn.
 *
 * ELK's `layered` algorithm is the same family of algorithm as dagre — assign ranks, order within
 * a rank to reduce crossings, then place — but it also routes the edges, which is the part that
 * decides whether a dense graph can be read at all. `ORTHOGONAL` routing reserves lanes between
 * the rows, gives each edge of a card its own point on that card's border, and takes an edge that
 * spans several ranks around the cards it passes instead of through them.
 *
 * https://eclipse.dev/elk/reference/options.html
 */
const ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.spacing.nodeNode': '28',
  'elk.layered.spacing.nodeNodeBetweenLayers': '76',
  'elk.spacing.edgeNode': '20',
  'elk.spacing.edgeEdge': '16',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
  // Each connected piece of work is laid out on its own and the pieces are packed to a screen
  // shape, so a backlog of small chains does not open as one enormous row.
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '76',
  'elk.aspectRatio': String(TARGET_ASPECT),
}

interface ElkNode {
  id: string
  width?: number
  height?: number
  x?: number
  y?: number
  children?: ElkNode[]
  edges?: ElkEdge[]
  layoutOptions?: Record<string, string>
}

interface ElkEdge {
  id: string
  sources: string[]
  targets: string[]
  sections?: { startPoint: Point; bendPoints?: Point[]; endPoint: Point }[]
}

interface ElkEngine {
  layout(graph: ElkNode): Promise<ElkNode>
}

let engine: Promise<ElkEngine> | null = null

/**
 * ELK is a megabyte of compiled Java, so it is fetched only when a graph is actually drawn and
 * kept for the rest of the session.
 */
async function elk(): Promise<ElkEngine> {
  engine ??= import('elkjs/lib/elk.bundled.js').then(
    (module) => new (module.default as unknown as new () => ElkEngine)(),
  )
  return engine
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

function groupLabel(kind: GraphGroup['kind'], count: number): string {
  const issues = `${count} issue${count === 1 ? '' : 's'}`
  // The two frames mean opposite things, so each says which it is rather than leaving the reader
  // to infer it from a border style.
  return kind === 'chain' ? `Chain · ${issues}` : `Independent · ${issues}`
}

/** Frames a set of cards from where they actually landed. */
function frameOf(members: GraphNode[], kind: GraphGroup['kind']): GraphGroup {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const node of members) {
    left = Math.min(left, node.position.x)
    top = Math.min(top, node.position.y)
    right = Math.max(right, node.position.x + NODE_WIDTH)
    bottom = Math.max(bottom, node.position.y + node.height)
  }

  const ids = members.map((node) => node.id).sort()
  return {
    id: `group:${ids[0]}`,
    kind,
    label: groupLabel(kind, members.length),
    members: ids,
    position: { x: left - GROUP_PADDING, y: top - GROUP_PADDING - GROUP_LABEL_HEIGHT },
    width: right - left + GROUP_PADDING * 2,
    height: bottom - top + GROUP_PADDING * 2 + GROUP_LABEL_HEIGHT,
  }
}

/**
 * Packs the issues that depend on nothing into their own block.
 *
 * They have no edges, so a layered algorithm has nothing to say about them and would only spread
 * them across the canvas. Filling the shortest column each time keeps the block dense even though
 * the cards differ in height.
 */
function packLoose(nodes: GraphNode[], columns: number, originY: number): void {
  const used = Math.max(1, Math.min(columns, nodes.length))
  const heights = new Array<number>(used).fill(originY)

  for (const node of nodes) {
    let column = 0
    for (let index = 1; index < used; index += 1) {
      if (heights[index] < heights[column]) column = index
    }
    node.position = { x: column * (NODE_WIDTH + GRID_GAP), y: heights[column] }
    heights[column] += node.height + GRID_GAP
  }
}

export interface Layout {
  nodes: GraphNode[]
  groups: GraphGroup[]
  /** Edge id to the orthogonal route ELK reserved for it. */
  routes: Map<string, Point[]>
}

/**
 * Lays the graph out: ELK draws everything that has a dependency, and the rest is packed beneath
 * it as one block, because an issue that blocks nothing and waits for nothing has no place in a
 * layered drawing beyond taking up room in it.
 */
export async function layout(nodes: GraphNode[], edges: GraphEdge[]): Promise<Layout> {
  if (nodes.length === 0) return { nodes, groups: [], routes: new Map() }

  const components = componentsOf(nodes, edges)
  const connected = components.filter((group) => group.length > 1)
  const loose = components.filter((group) => group.length === 1).flat()
  const placed = new Map<string, GraphNode>(
    nodes.map((node) => [node.id, { ...node, position: { x: 0, y: 0 } }]),
  )
  const routes = new Map<string, Point[]>()
  const groups: GraphGroup[] = []
  let drawnHeight = 0
  let drawnWidth = NODE_WIDTH * 4

  if (connected.length > 0) {
    const members = connected.flat()
    const ids = new Set(members.map((node) => node.id))
    const result = await (
      await elk()
    ).layout({
      id: 'root',
      layoutOptions: ELK_OPTIONS,
      children: members.map((node) => ({
        id: node.id,
        width: NODE_WIDTH,
        height: node.height,
      })),
      edges: edges
        .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
        .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
    })

    for (const child of result.children ?? []) {
      const node = placed.get(child.id)
      if (node) node.position = { x: child.x ?? 0, y: child.y ?? 0 }
    }

    for (const edge of result.edges ?? []) {
      const section = edge.sections?.[0]
      if (!section) continue
      routes.set(edge.id, [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ])
    }

    for (const component of connected) {
      groups.push(frameOf(component.map((node) => placed.get(node.id)!), 'chain'))
    }

    drawnWidth = Math.max(drawnWidth, ...groups.map((group) => group.position.x + group.width))
    drawnHeight = Math.max(...groups.map((group) => group.position.y + group.height))
  }

  if (loose.length > 0) {
    // The block is shaped for the screen in its own right: taking the drawn width alone would
    // leave a repository with two small chains and forty loose issues as one tall column.
    const area = loose.reduce(
      (sum, node) => sum + (NODE_WIDTH + GRID_GAP) * (node.height + GRID_GAP),
      0,
    )
    const wanted = Math.max(drawnWidth, Math.sqrt(area * TARGET_ASPECT))
    const columns = Math.max(1, Math.round(wanted / (NODE_WIDTH + GRID_GAP)))
    const block = loose.map((node) => placed.get(node.id)!)
    packLoose(block, columns, connected.length > 0 ? drawnHeight + BLOCK_GAP : 0)
    groups.push(frameOf(block, 'free'))
  }

  return { nodes: nodes.map((node) => placed.get(node.id)!), groups, routes }
}

export interface BuildOptions {
  /**
   * Draws closed blockers and the edges into them. Off by default: a finished blocker no longer
   * blocks, so the issue it used to block belongs with the work that is ready to start, and a
   * backlog reads as what is left to do rather than as what has already happened.
   */
  showClosed?: boolean
}

export async function buildGraph(
  data: RepositoryGraphData,
  target: RepoTarget,
  options: BuildOptions = {},
): Promise<IssueGraph> {
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

  const laid = await layout([...nodes.values()], edges)

  return {
    nodes: laid.nodes,
    edges: edges.map((edge) => ({ ...edge, points: laid.routes.get(edge.id) })),
    groups: laid.groups,
    complete: data.complete,
    unresolved: data.unresolved,
    rateLimited: data.rateLimited,
    rateLimitReset: data.rateLimitReset,
    requestCount: data.requestCount,
  }
}
