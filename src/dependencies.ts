import type { GraphNode, IssueGraph } from './graph'

/**
 * The dependency relationships, said in words.
 *
 * Everything here is derived from `IssueGraph.edges` and nothing else, which is what keeps the
 * spoken graph and the drawn graph the same graph. Every rule that shapes the drawing — closed
 * blockers included or left out, blockers that could not be read, blockers pulled in from another
 * repository — has already been applied by the time an edge exists, so a second set of rules here
 * would be a second answer to the same question. Pure: no network, no React, no DOM.
 */

export interface Adjacency {
  /** Issues that have to land before this one. */
  blockedBy: GraphNode[]
  /** Issues waiting on this one. */
  blocks: GraphNode[]
}

/**
 * How an issue is named where a reader has to act on it.
 *
 * A bare number belongs to a repository's own numbering, so an external issue carries its
 * repository and a local one does not. This is the rule the cards' own controls already use; it
 * lives here so both surfaces read the same.
 */
export function issueRef(node: GraphNode): string {
  return node.external ? `${node.repo}#${node.number}` : `#${node.number}`
}

/** Repository first, then number, so a reading order does not depend on edge order. */
function byRef(a: GraphNode, b: GraphNode): number {
  return a.repo === b.repo ? a.number - b.number : a.repo.localeCompare(b.repo)
}

/**
 * Both sides of every drawn edge, per node.
 *
 * One pass over the edges. A node with no edge still gets an entry, because "nothing blocks this"
 * is an answer a reader needs and an absent entry is not one.
 */
export function adjacencyOf(graph: IssueGraph): Map<string, Adjacency> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const adjacency = new Map<string, Adjacency>(
    graph.nodes.map((node) => [node.id, { blockedBy: [], blocks: [] }]),
  )

  for (const edge of graph.edges) {
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (!source || !target) continue
    adjacency.get(target.id)?.blockedBy.push(source)
    adjacency.get(source.id)?.blocks.push(target)
  }

  for (const entry of adjacency.values()) {
    entry.blockedBy.sort(byRef)
    entry.blocks.sort(byRef)
  }

  return adjacency
}

/** `#23 and #24`, `#23, #24 and other/lib#7`. */
function listRefs(nodes: GraphNode[]): string {
  const refs = nodes.map(issueRef)
  if (refs.length <= 1) return refs.join('')
  return `${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]}`
}

/**
 * What a card says about its place in the graph, e.g.
 * `Issue #25. Blocked by #23 and #24. Blocks #31.`
 *
 * Both directions are always stated. An empty side reads as "nothing" rather than being left out,
 * so a reader hears the absence of a blocker instead of having to notice a missing sentence.
 */
export function describeNode(node: GraphNode, adjacency: Adjacency | undefined): string {
  const blockedBy = adjacency?.blockedBy ?? []
  const blocks = adjacency?.blocks ?? []

  return [
    `Issue ${issueRef(node)}.`,
    blockedBy.length > 0 ? `Blocked by ${listRefs(blockedBy)}.` : 'Blocked by nothing.',
    blocks.length > 0 ? `Blocks ${listRefs(blocks)}.` : 'Blocks nothing.',
  ].join(' ')
}

/** One drawn edge, named on both ends. */
export interface DependencyRow {
  id: string
  blocker: GraphNode
  dependent: GraphNode
}

/**
 * Every drawn edge, once, in a stable order: the table a reader traverses instead of the picture.
 *
 * Sorted by the blocker and then by what it blocks, so an issue holding several others up reads as
 * one run of rows rather than as entries scattered through the list.
 */
export function dependencyRows(graph: IssueGraph): DependencyRow[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const rows: DependencyRow[] = []

  for (const edge of graph.edges) {
    const blocker = byId.get(edge.source)
    const dependent = byId.get(edge.target)
    if (!blocker || !dependent) continue
    rows.push({ id: edge.id, blocker, dependent })
  }

  return rows.sort(
    (a, b) => byRef(a.blocker, b.blocker) || byRef(a.dependent, b.dependent),
  )
}
