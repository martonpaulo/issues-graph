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
  /**
   * Issues this one is part of, and issues this one is made of.
   *
   * Kept apart from the two above rather than folded into them, because containment is not an
   * ordering: a parent holds none of its children up and waits on none of them. The canvas says
   * that by drawing the line without an arrowhead, which is exactly the distinction a reader of
   * this model cannot see, so it is carried here by being a different field entirely.
   */
  parents: GraphNode[]
  children: GraphNode[]
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
 * Both sides of every drawn dependency, per node.
 *
 * One pass over the edges. A node with no edge still gets an entry, because "nothing blocks this"
 * is an answer a reader needs and an absent entry is not one.
 *
 * Both kinds of edge are read, into fields that never meet. A `dependency` edge says which issue
 * has to land first and fills `blockedBy` and `blocks`; a `hierarchy` edge says which issue
 * contains another, says nothing about which comes first, and fills `parents` and `children`.
 * Reading a hierarchy edge as a blocker would invent an ordering that neither GitHub nor the
 * drawing claims, and would invent it only for the reader who cannot see that the arrowhead is
 * missing — but leaving it out entirely hides a line the picture draws from the same reader.
 */
export function adjacencyOf(graph: IssueGraph): Map<string, Adjacency> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const adjacency = new Map<string, Adjacency>(
    graph.nodes.map((node) => [node.id, { blockedBy: [], blocks: [], parents: [], children: [] }]),
  )

  for (const edge of graph.edges) {
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (!source || !target) continue
    if (edge.kind === 'dependency') {
      adjacency.get(target.id)?.blockedBy.push(source)
      adjacency.get(source.id)?.blocks.push(target)
    } else {
      // The source of a hierarchy edge is the parent, so the target is what it is part of.
      adjacency.get(target.id)?.parents.push(source)
      adjacency.get(source.id)?.children.push(target)
    }
  }

  for (const entry of adjacency.values()) {
    entry.blockedBy.sort(byRef)
    entry.blocks.sort(byRef)
    entry.parents.sort(byRef)
    entry.children.sort(byRef)
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
 * `Issue #25. Blocked by #23. Blocks nothing. Part of #20. Contains #26 and #27.`
 *
 * Both directions of the ordering are always stated. An empty side reads as "nothing" rather than
 * being left out, so a reader hears the absence of a blocker instead of having to notice a missing
 * sentence.
 *
 * Containment follows in clauses of its own, never merged into the two before it: `Part of` and
 * `Contains` are not `Blocked by` and `Blocks`, and a reader who cannot see the missing arrowhead
 * has only these words to tell the two relations apart. Unlike the ordering clauses, an empty one
 * is dropped: most issues belong to no breakdown at all, and `Part of nothing.` on every card
 * would pay for an announcement nobody is waiting to hear. Every drawn edge is still said — an
 * absent clause means no such edge exists, not that one was left out.
 */
export function describeNode(node: GraphNode, adjacency: Adjacency | undefined): string {
  const blockedBy = adjacency?.blockedBy ?? []
  const blocks = adjacency?.blocks ?? []
  const parents = adjacency?.parents ?? []
  const children = adjacency?.children ?? []

  return [
    `Issue ${issueRef(node)}.`,
    blockedBy.length > 0 ? `Blocked by ${listRefs(blockedBy)}.` : 'Blocked by nothing.',
    blocks.length > 0 ? `Blocks ${listRefs(blocks)}.` : 'Blocks nothing.',
    parents.length > 0 ? `Part of ${listRefs(parents)}.` : null,
    children.length > 0 ? `Contains ${listRefs(children)}.` : null,
  ]
    .filter((clause): clause is string => clause !== null)
    .join(' ')
}

/** One drawn edge, named on both ends. */
export interface DependencyRow {
  id: string
  blocker: GraphNode
  dependent: GraphNode
}

/**
 * Every drawn dependency, once, in a stable order: the table a reader traverses instead of the
 * picture. Hierarchy edges are left out because this table only claims to hold orderings, and a
 * mixed row would make that claim conditional; `containmentRows` holds them instead, so no drawn
 * edge is unreachable and no row of either table has to be qualified.
 *
 * Sorted by the blocker and then by what it blocks, so an issue holding several others up reads as
 * one run of rows rather than as entries scattered through the list.
 */
export function dependencyRows(graph: IssueGraph): DependencyRow[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const rows: DependencyRow[] = []

  for (const edge of graph.edges) {
    if (edge.kind !== 'dependency') continue
    const blocker = byId.get(edge.source)
    const dependent = byId.get(edge.target)
    if (!blocker || !dependent) continue
    rows.push({ id: edge.id, blocker, dependent })
  }

  return rows.sort(
    (a, b) => byRef(a.blocker, b.blocker) || byRef(a.dependent, b.dependent),
  )
}

/** One drawn hierarchy edge, named on both ends. */
export interface ContainmentRow {
  id: string
  parent: GraphNode
  child: GraphNode
}

/**
 * Every drawn containment, once, in a stable order: `dependencyRows` for the other kind of edge.
 *
 * A second table rather than a kind column on the first, because the dependency table's caption
 * claims that every row is an ordering and a mixed table would make that claim false for half of
 * them. Two uniform lists each keep a caption that is true of every row, and a screen reader
 * traverses a table by row and column within one table anyway.
 *
 * Sorted by the parent and then by the child, so a parent holding several sub-issues reads as one
 * run of rows.
 */
export function containmentRows(graph: IssueGraph): ContainmentRow[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const rows: ContainmentRow[] = []

  for (const edge of graph.edges) {
    if (edge.kind !== 'hierarchy') continue
    const parent = byId.get(edge.source)
    const child = byId.get(edge.target)
    if (!parent || !child) continue
    rows.push({ id: edge.id, parent, child })
  }

  return rows.sort((a, b) => byRef(a.parent, b.parent) || byRef(a.child, b.child))
}
