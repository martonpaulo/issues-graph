import dagre from '@dagrejs/dagre'

import type { IssuePayload, RepositoryGraphData, UnresolvedDependency } from './github'
import { cardLabels, hasNamespace, type ParsedLabel } from './labels'
import type { RepoTarget } from './route'

/**
 * Turns GitHub's payloads into a laid-out graph. Pure: no network, no React, no DOM. Every
 * dependency edge here comes from a native `blocked_by` relationship — issue prose is never read,
 * so a body claiming "depends on #123" cannot invent an edge.
 */

/** Fixed so layout is predictable; the card clamps its title to fit. */
export const NODE_WIDTH = 232
export const NODE_HEIGHT = 92

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
  labels: ParsedLabel[]
  position: { x: number; y: number }
}

export interface GraphEdge {
  id: string
  /** The blocker: it has to land first. */
  source: string
  target: string
}

export interface IssueGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
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
  return {
    id: nodeId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    repo,
    state: deriveState(issue),
    external: repo !== `${target.owner}/${target.repo}`,
    labels: cardLabels(issue.labels),
    position: { x: 0, y: 0 },
  }
}

/** Space between cards in the grid, and between packed components. */
const GRID_GAP = 20
const COMPONENT_GAP = 56

/** Roughly 16:9. Layout aims for this so the whole graph fits a screen after fit-to-view. */
const TARGET_ASPECT = 1.9

interface Box {
  width: number
  height: number
  positions: Map<string, { x: number; y: number }>
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

const RANK_GAP = 56
const SUBROW_GAP = 22

/**
 * Ranks one component with dagre, then wraps any rank too wide for the target.
 *
 * dagre puts every sibling on one rank, which is correct and unreadable: one martonpaulo/tabelo
 * component fans 31 issues off their blockers, nearly 8000px across. Wrapping that rank into
 * sub-rows keeps the ranking — blockers stay above what they block — while bringing the component
 * back to a shape that fits a screen. dagre's within-rank ordering is preserved, so the crossing
 * minimisation it computed is not thrown away.
 */
function layoutComponent(nodes: GraphNode[], edges: GraphEdge[], maxWidth: number): Box {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', ranksep: RANK_GAP, nodesep: 24, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))

  const ids = new Set(nodes.map((node) => node.id))
  for (const node of nodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  // Group by rank, keeping dagre's left-to-right order inside each one.
  const ranks = new Map<number, { id: string; x: number }[]>()
  for (const node of nodes) {
    const laid = g.node(node.id)
    const rank = Math.round(laid?.y ?? 0)
    const row = ranks.get(rank)
    const entry = { id: node.id, x: laid?.x ?? 0 }
    if (row) row.push(entry)
    else ranks.set(rank, [entry])
  }

  const columns = Math.max(1, Math.floor((maxWidth + 24) / (NODE_WIDTH + 24)))
  const positions = new Map<string, { x: number; y: number }>()
  let cursorY = 0
  let width = 0

  for (const rank of [...ranks.keys()].sort((a, b) => a - b)) {
    const row = ranks.get(rank)!.sort((a, b) => a.x - b.x)
    const perRow = Math.min(columns, row.length)
    const subRows = Math.ceil(row.length / perRow)

    row.forEach((entry, index) => {
      const column = index % perRow
      const subRow = Math.floor(index / perRow)
      // Centre each sub-row so a wrapped fan still reads as one group under its blocker.
      const count = Math.min(perRow, row.length - subRow * perRow)
      const rowWidth = count * NODE_WIDTH + (count - 1) * 24
      const offset = (perRow * NODE_WIDTH + (perRow - 1) * 24 - rowWidth) / 2
      const x = offset + column * (NODE_WIDTH + 24)
      positions.set(entry.id, { x, y: cursorY + subRow * (NODE_HEIGHT + SUBROW_GAP) })
      width = Math.max(width, x + NODE_WIDTH)
    })

    cursorY += subRows * NODE_HEIGHT + (subRows - 1) * SUBROW_GAP + RANK_GAP
  }

  return { width, height: Math.max(0, cursorY - RANK_GAP), positions }
}

/** Packs every dependency-free issue into one block instead of one very long rank. */
function gridBox(nodes: GraphNode[], columns: number): Box {
  const positions = new Map<string, { x: number; y: number }>()
  nodes.forEach((node, index) => {
    positions.set(node.id, {
      x: (index % columns) * (NODE_WIDTH + GRID_GAP),
      y: Math.floor(index / columns) * (NODE_HEIGHT + GRID_GAP),
    })
  })
  const rows = Math.ceil(nodes.length / columns)
  const used = Math.min(columns, nodes.length)
  return {
    width: used * NODE_WIDTH + (used - 1) * GRID_GAP,
    height: rows * NODE_HEIGHT + (rows - 1) * GRID_GAP,
    positions,
  }
}

/**
 * Lays the graph out as packed components rather than as one dagre run.
 *
 * dagre places every weakly-connected component on the same rank line, so a backlog of many small
 * independent chains opens as one enormous row: martonpaulo/tabelo measured 10112x592, an aspect of
 * 17:1, with 31 cards on a single rank. Ranking each component on its own and then shelf-packing
 * the results turns the same graph into something close to a screen shape, and every dependency
 * chain stays intact and readable inside its own block.
 */
export function layout(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  if (nodes.length === 0) return nodes

  const components = componentsOf(nodes, edges)
  const structured = components.filter((group) => group.length > 1)
  const singles = components.filter((group) => group.length === 1).flat()

  // First pass: how big is each component when nothing is wrapped? A deep chain is naturally tall
  // and a wide fan naturally broad, and a target guessed from the node count alone gets both wrong.
  const natural = structured.map((group) => layoutComponent(group, edges, Infinity))
  const naturalArea = natural.reduce((sum, box) => sum + box.width * box.height, 0)
  const singlesArea = singles.length * (NODE_WIDTH + GRID_GAP) * (NODE_HEIGHT + GRID_GAP)
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

  const placed = new Map<string, { x: number; y: number }>()
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0

  const place = (box: Box) => {
    if (cursorX > 0 && cursorX + box.width > target) {
      cursorX = 0
      cursorY += rowHeight + COMPONENT_GAP
      rowHeight = 0
    }
    for (const [id, position] of box.positions) {
      placed.set(id, { x: cursorX + position.x, y: cursorY + position.y })
    }
    cursorX += box.width + COMPONENT_GAP
    rowHeight = Math.max(rowHeight, box.height)
  }

  for (const { box } of boxes) place(box)

  if (singles.length > 0) {
    const columns = Math.max(1, Math.floor((target + GRID_GAP) / (NODE_WIDTH + GRID_GAP)))
    // The dependency-free block starts its own row, so it reads as a separate group.
    if (cursorX > 0) {
      cursorX = 0
      cursorY += rowHeight + COMPONENT_GAP
      rowHeight = 0
    }
    place(gridBox(singles, columns))
  }

  return nodes.map((node) => ({ ...node, position: placed.get(node.id) ?? node.position }))
}

export function buildGraph(data: RepositoryGraphData, target: RepoTarget): IssueGraph {
  const nodes = new Map<string, GraphNode>()
  for (const issue of data.issues) {
    const node = toNode(issue, target)
    nodes.set(node.id, node)
  }

  const edges: GraphEdge[] = []
  const seen = new Set<string>()

  for (const [number, blockers] of data.blockers) {
    const targetId = nodeId(`${target.owner}/${target.repo}`, number)
    if (!nodes.has(targetId)) continue

    for (const blocker of blockers) {
      // A blocker in another repository is not in the issue list, so it joins the graph here.
      const blockerNode = toNode(blocker, target)
      if (!nodes.has(blockerNode.id)) nodes.set(blockerNode.id, blockerNode)

      const id = `${blockerNode.id}->${targetId}`
      if (seen.has(id)) continue
      seen.add(id)
      edges.push({ id, source: blockerNode.id, target: targetId })
    }
  }

  return {
    nodes: layout([...nodes.values()], edges),
    edges,
    complete: data.complete,
    unresolved: data.unresolved,
    rateLimited: data.rateLimited,
    rateLimitReset: data.rateLimitReset,
    requestCount: data.requestCount,
  }
}
