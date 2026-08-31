import { describe, expect, it } from 'vitest'

import arbaroBlockedBy from './__fixtures__/arbaro.blocked-by.json'
import arbaroIssues from './__fixtures__/arbaro.issues.json'
import tabeloBlockedBy from './__fixtures__/tabelo.blocked-by.json'
import tabeloIssues from './__fixtures__/tabelo.issues.json'
import {
  adjacencyOf,
  containmentRows,
  dependencyRows,
  describeNode,
  issueRef,
} from './dependencies'
import type { IssuePayload, RepositoryGraphData } from './github'
import {
  buildGraph,
  nodeId,
  type GraphEdge,
  type GraphNode,
  type IssueGraph,
} from './graph'

const ARBARO = { owner: 'martonpaulo', repo: 'arbaro' }

function dataFrom(
  issues: unknown,
  blockedBy: unknown,
  overrides: Partial<RepositoryGraphData> = {},
): RepositoryGraphData {
  const blockers = new Map(
    Object.entries(blockedBy as Record<string, IssuePayload[]>).map(([number, list]) => [
      Number(number),
      list,
    ]),
  )
  return {
    issues: issues as IssuePayload[],
    blockers,
    complete: true,
    unresolved: [],
    rateLimited: false,
    rateLimitReset: null,
    requestCount: 1 + blockers.size,
    rateLimit: null,
    includedClosed: true,
    ...overrides,
  }
}

/** The same shape `graph.test.ts` builds a synthetic payload from. */
function issue(over: Partial<IssuePayload> = {}): IssuePayload {
  return {
    number: 1,
    title: 'An issue',
    state: 'open',
    state_reason: null,
    html_url: 'https://github.com/acme/app/issues/1',
    repository_url: 'https://api.github.com/repos/acme/app',
    labels: [],
    issue_dependencies_summary: {
      blocked_by: 0,
      total_blocked_by: 0,
      blocking: 0,
      total_blocking: 0,
    },
    ...over,
  }
}

function describe_(graph: IssueGraph, id: string): string {
  const node = graph.nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`no node ${id}`)
  return describeNode(node, adjacencyOf(graph).get(id))
}

describe('issueRef', () => {
  it('names a local issue by number and an external one by repository', async () => {
    const graph = await buildGraph(
      dataFrom(
        [issue({ number: 3 })],
        { 3: [issue({ number: 9, repository_url: 'https://api.github.com/repos/other/lib' })] },
      ),
      { owner: 'acme', repo: 'app' },
    )

    expect(graph.nodes.map(issueRef).sort()).toEqual(['#3', 'other/lib#9'])
  })
})

describe('adjacencyOf', () => {
  it('reads both directions of every drawn edge and nothing else', async () => {
    const graph = await buildGraph(dataFrom(arbaroIssues, arbaroBlockedBy), ARBARO)
    const adjacency = adjacencyOf(graph)

    // Every node has an entry, so "nothing blocks this" is an answer rather than a gap.
    expect(adjacency.size).toBe(graph.nodes.length)

    const pairs: string[] = []
    for (const [id, entry] of adjacency) {
      for (const blocker of entry.blockedBy) pairs.push(`${blocker.id}->${id}`)
    }
    expect(pairs.sort()).toEqual(
      graph.edges.filter((edge) => edge.kind === 'dependency').map((edge) => edge.id).sort(),
    )

    // The mirror side has to agree edge for edge, or a card would announce one direction only.
    const mirrored: string[] = []
    for (const [id, entry] of adjacency) {
      for (const dependent of entry.blocks) mirrored.push(`${id}->${dependent.id}`)
    }
    expect(mirrored.sort()).toEqual(pairs.sort())
  })

  it('follows the drawn edges rather than GitHub’s own dependency counts', async () => {
    // #11 is blocked only by closed issues, so the default view draws no blocker for it even
    // though the payload still reports a total.
    const target = (arbaroIssues as IssuePayload[]).find((candidate) => candidate.number === 11)
    expect(target?.issue_dependencies_summary?.total_blocked_by).toBeGreaterThan(0)

    const open = await buildGraph(dataFrom(arbaroIssues, arbaroBlockedBy), ARBARO)
    expect(describe_(open, nodeId('martonpaulo/arbaro', 11))).toContain('Blocked by nothing.')

    const closed = await buildGraph(dataFrom(arbaroIssues, arbaroBlockedBy), ARBARO, {
      showClosed: true,
    })
    expect(describe_(closed, nodeId('martonpaulo/arbaro', 11))).toContain('Blocked by #1 and #5.')
  })
})

describe('describeNode', () => {
  it('states a fork as one sentence per direction', async () => {
    const graph = await buildGraph(
      dataFrom(
        [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 }), issue({ number: 4 })],
        { 2: [issue({ number: 1 })], 3: [issue({ number: 1 })], 4: [issue({ number: 3 })] },
      ),
      { owner: 'acme', repo: 'app' },
    )

    expect(describe_(graph, 'acme/app#1')).toBe(
      'Issue #1. Blocked by nothing. Blocks #2 and #3.',
    )
    expect(describe_(graph, 'acme/app#3')).toBe('Issue #3. Blocked by #1. Blocks #4.')
    expect(describe_(graph, 'acme/app#4')).toBe('Issue #4. Blocked by #3. Blocks nothing.')
  })

  it('keeps a cross-repository blocker qualified on both cards', async () => {
    const graph = await buildGraph(
      dataFrom(
        [issue({ number: 5 })],
        {
          5: [
            issue({
              number: 9,
              repository_url: 'https://api.github.com/repos/other/lib',
              html_url: 'https://github.com/other/lib/issues/9',
            }),
          ],
        },
      ),
      { owner: 'acme', repo: 'app' },
    )

    expect(describe_(graph, 'acme/app#5')).toBe(
      'Issue #5. Blocked by other/lib#9. Blocks nothing.',
    )
    expect(describe_(graph, 'other/lib#9')).toBe(
      'Issue other/lib#9. Blocked by nothing. Blocks #5.',
    )
  })

  it('lists three or more blockers with commas and a final "and"', async () => {
    const graph = await buildGraph(
      dataFrom(
        [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 }), issue({ number: 4 })],
        { 4: [issue({ number: 3 }), issue({ number: 1 }), issue({ number: 2 })] },
      ),
      { owner: 'acme', repo: 'app' },
    )

    expect(describe_(graph, 'acme/app#4')).toBe(
      'Issue #4. Blocked by #1, #2 and #3. Blocks nothing.',
    )
  })
})

describe('a sub-issue hierarchy, as GitHub actually returned one', () => {
  const TABELO = { owner: 'martonpaulo', repo: 'tabelo' }

  /**
   * The captured `tabelo` read is the only breakdown any fixture holds, and it is the awkward
   * shape rather than the tidy one: #294 was split into #296 and #297, and also blocks #297. A repository doing both at once is what the two relations have to stay apart under, and
   * it is the case a hand-written payload could only assume.
   */
  async function tabelo() {
    return buildGraph(dataFrom(tabeloIssues, tabeloBlockedBy), TABELO)
  }

  it('says every drawn hierarchy edge, and says it as containment', async () => {
    const graph = await tabelo()
    const drawn = graph.edges.filter((edge) => edge.kind === 'hierarchy')
    expect(drawn.length).toBeGreaterThan(0)

    // The table reaches each one exactly once.
    expect(containmentRows(graph).map((row) => row.id).sort()).toEqual(
      drawn.map((edge) => edge.id).sort(),
    )

    // And both cards of every edge say it, in containment's own words.
    for (const edge of drawn) {
      const parent = graph.nodes.find((node) => node.id === edge.source)!
      const child = graph.nodes.find((node) => node.id === edge.target)!
      expect(describe_(graph, parent.id)).toContain(`Contains `)
      expect(describe_(graph, child.id)).toContain(`Part of ${issueRef(parent)}`)
    }
  })

  it('keeps the ordering and the containment apart on the issue that has both', async () => {
    const graph = await tabelo()

    // #294 contains #296 and #297, and separately blocks #297. The same pair therefore carries
    // both relations at once, and each is said in its own words: "Blocks #297" and "Contains …"
    // stand side by side without either borrowing the other's meaning.
    expect(describe_(graph, 'martonpaulo/tabelo#294')).toBe(
      'Issue #294. Blocked by nothing. Blocks #297. Contains #296 and #297.',
    )
    expect(describe_(graph, 'martonpaulo/tabelo#297')).toBe(
      'Issue #297. Blocked by #294. Blocks nothing. Part of #294.',
    )
    // #296 is contained and nothing more: no ordering clause acquires it.
    expect(describe_(graph, 'martonpaulo/tabelo#296')).toBe(
      'Issue #296. Blocked by nothing. Blocks nothing. Part of #294.',
    )

    // The two tables partition the drawn edges: neither holds one of the other's.
    const dependencies = dependencyRows(graph).map((row) => row.id)
    const containment = containmentRows(graph).map((row) => row.id)
    expect(dependencies.filter((id) => containment.includes(id))).toEqual([])
    expect([...dependencies, ...containment].sort()).toEqual(
      graph.edges.map((edge) => edge.id).sort(),
    )
  })
})

/**
 * The topologies a captured read cannot hold, built at the seam this module actually has.
 *
 * `dependencies.ts` takes an `IssueGraph` and returns words. It never sees a GitHub payload, so a
 * payload is the wrong thing to write here: constructing one would assert what the API returns,
 * which is the assumption captured fixtures exist to catch, and it would assert it in a test that
 * does not even exercise the code that reads payloads. Building the `IssueGraph` directly states
 * the input this contract is defined over — the same thing `GraphView.test.ts` does when it needs a
 * graph the geometry does not care about — and it reaches shapes `buildGraph` cannot currently
 * produce from any repository, which is exactly where an acceptance criterion is still owed proof.
 *
 * The captured `tabelo` read above proves the whole path from a real API response; these prove the
 * corners it does not contain. Neither substitutes for the other.
 */
describe('a sub-issue hierarchy, at the IssueGraph seam', () => {
  function node(over: Partial<GraphNode> & Pick<GraphNode, 'id' | 'number' | 'repo'>): GraphNode {
    return {
      title: `Issue ${over.number}`,
      url: `https://github.com/${over.repo}/issues/${over.number}`,
      state: null,
      open: true,
      subIssues: null,
      external: false,
      repoLabel: over.repo,
      labels: [],
      allLabels: [],
      titleLines: 1,
      height: 100,
      position: { x: 0, y: 0 },
      ...over,
    }
  }

  /** Only `nodes` and `edges` reach this module; the rest of the graph is carried, not read. */
  function graphOf(nodes: GraphNode[], edges: GraphEdge[]): IssueGraph {
    return {
      nodes,
      edges,
      groups: [],
      identity: 'acme/app',
      complete: true,
      unresolved: [],
      rateLimited: false,
      rateLimitReset: null,
      requestCount: 0,
    }
  }

  const local = node({ id: 'acme/app#5', number: 5, repo: 'acme/app' })
  const child = node({ id: 'acme/app#6', number: 6, repo: 'acme/app' })
  const foreign = node({
    id: 'other/lib#9',
    number: 9,
    repo: 'other/lib',
    external: true,
  })

  function hierarchy(parent: GraphNode, kid: GraphNode, over: Partial<GraphEdge> = {}): GraphEdge {
    return {
      id: `${parent.id}=>${kid.id}`,
      kind: 'hierarchy',
      source: parent.id,
      target: kid.id,
      ...over,
    }
  }

  it('keeps a sub-issue whose parent is elsewhere qualified on both cards', () => {
    const graph = graphOf([child, foreign], [hierarchy(foreign, child)])

    expect(describe_(graph, 'acme/app#6')).toBe(
      'Issue #6. Blocked by nothing. Blocks nothing. Part of other/lib#9.',
    )
    expect(describe_(graph, 'other/lib#9')).toBe(
      'Issue other/lib#9. Blocked by nothing. Blocks nothing. Contains #6.',
    )
    expect(containmentRows(graph).map((row) => `${issueRef(row.parent)}->${issueRef(row.child)}`))
      .toEqual(['other/lib#9->#6'])
  })

  it('keeps a parent whose sub-issue is elsewhere qualified on both cards', () => {
    // The other direction the acceptance criterion names, and the one no fixture can carry:
    // `buildGraph` reads containment off the target repository's own issue list, so a child from
    // another repository never reaches it. The words still have to be right if one ever does, and
    // this module is where that is decided.
    const graph = graphOf([local, foreign], [hierarchy(local, foreign)])

    expect(describe_(graph, 'acme/app#5')).toBe(
      'Issue #5. Blocked by nothing. Blocks nothing. Contains other/lib#9.',
    )
    expect(describe_(graph, 'other/lib#9')).toBe(
      'Issue other/lib#9. Blocked by nothing. Blocks nothing. Part of #5.',
    )
    expect(containmentRows(graph).map((row) => `${issueRef(row.parent)}->${issueRef(row.child)}`))
      .toEqual(['#5->other/lib#9'])
  })

  it('never lets containment reach an ordering, in either direction', () => {
    const blocker = node({ id: 'acme/app#7', number: 7, repo: 'acme/app' })
    const graph = graphOf(
      [local, child, blocker],
      [
        hierarchy(local, child),
        { id: 'acme/app#7->acme/app#6', kind: 'dependency', source: blocker.id, target: child.id },
      ],
    )
    const adjacency = adjacencyOf(graph)

    // The parent contains #6 and neither blocks it nor waits on it.
    expect(adjacency.get('acme/app#5')?.blockedBy).toEqual([])
    expect(adjacency.get('acme/app#5')?.blocks).toEqual([])
    expect(adjacency.get('acme/app#5')?.children.map((n) => n.id)).toEqual(['acme/app#6'])
    // And the real blocker is nobody's parent.
    expect(adjacency.get('acme/app#7')?.children).toEqual([])
    expect(adjacency.get('acme/app#6')?.parents.map((n) => n.id)).toEqual(['acme/app#5'])

    expect(describe_(graph, 'acme/app#5')).toBe(
      'Issue #5. Blocked by nothing. Blocks nothing. Contains #6.',
    )
    expect(describe_(graph, 'acme/app#6')).toBe(
      'Issue #6. Blocked by #7. Blocks nothing. Part of #5.',
    )
    // An issue in no breakdown says nothing about containment rather than "Part of nothing".
    expect(describe_(graph, 'acme/app#7')).toBe('Issue #7. Blocked by nothing. Blocks #6.')

    // The two tables partition the edges: neither holds one of the other's.
    expect(dependencyRows(graph).map((row) => row.id)).toEqual(['acme/app#7->acme/app#6'])
    expect(containmentRows(graph).map((row) => row.id)).toEqual(['acme/app#5=>acme/app#6'])
  })

  it('reports a closed parent that the drawing chose to include', () => {
    // Whether a closed parent is drawn at all is `buildGraph`'s decision and is proved in
    // `graph.test.ts`; this module only ever sees the edges that survived it. What it owes is the
    // state column, so a parent that is no longer live is not read as one that is.
    const finished = node({
      id: 'other/lib#9',
      number: 9,
      repo: 'other/lib',
      external: true,
      open: false,
    })
    const graph = graphOf([child, finished], [hierarchy(finished, child)])

    expect(describe_(graph, 'acme/app#6')).toContain('Part of other/lib#9.')
    expect(containmentRows(graph).map((row) => row.parent.open)).toEqual([false])
  })

  it('says nothing at all when the graph drew no containment', () => {
    const graph = graphOf(
      [local, child],
      [{ id: 'acme/app#5->acme/app#6', kind: 'dependency', source: local.id, target: child.id }],
    )

    expect(containmentRows(graph)).toEqual([])
    expect(describe_(graph, 'acme/app#5')).toBe('Issue #5. Blocked by nothing. Blocks #6.')
    expect(describe_(graph, 'acme/app#6')).toBe('Issue #6. Blocked by #5. Blocks nothing.')
  })

  it('reads an inverted hierarchy edge the way it is stored, not the way it is drawn', () => {
    // #130 hands a hierarchy edge that contradicts a dependency edge to the layout reversed and
    // marks it `inverted`. Only the drawing is reversed: `source` is still the parent, and the
    // words must not follow the picture.
    const graph = graphOf(
      [local, child],
      [
        hierarchy(local, child, { inverted: true }),
        { id: 'acme/app#6->acme/app#5', kind: 'dependency', source: child.id, target: local.id },
      ],
    )

    expect(describe_(graph, 'acme/app#5')).toBe(
      'Issue #5. Blocked by #6. Blocks nothing. Contains #6.',
    )
    expect(describe_(graph, 'acme/app#6')).toBe(
      'Issue #6. Blocked by nothing. Blocks #5. Part of #5.',
    )
  })
})

describe('a closed blocker in another repository', () => {
  /**
   * The one node with neither a local workflow state nor an open one. It is only in the picture
   * because closed blockers were asked for, so the picture has to be able to say why.
   */
  it('carries GitHub’s own closed state, which the local presentation state withholds', async () => {
    const graph = await buildGraph(
      dataFrom(
        [issue({ number: 5 })],
        {
          5: [
            issue({
              number: 9,
              state: 'closed',
              state_reason: 'completed',
              repository_url: 'https://api.github.com/repos/other/lib',
              html_url: 'https://github.com/other/lib/issues/9',
            }),
          ],
        },
      ),
      { owner: 'acme', repo: 'app' },
      { showClosed: true },
    )

    const blocker = graph.nodes.find((node) => node.id === 'other/lib#9')
    expect(blocker?.external).toBe(true)
    // The label convention behind `state` is this repository's own, so it stays withheld …
    expect(blocker?.state).toBeNull()
    // … while open or closed is GitHub's and is the fact a reader of a blocker needs.
    expect(blocker?.open).toBe(false)

    expect(describe_(graph, 'acme/app#5')).toBe(
      'Issue #5. Blocked by other/lib#9. Blocks nothing.',
    )
    expect(dependencyRows(graph).map((row) => row.blocker.id)).toEqual(['other/lib#9'])
  })

  it('is left out of the default view, like every other closed blocker', async () => {
    const graph = await buildGraph(
      dataFrom(
        [issue({ number: 5 })],
        {
          5: [
            issue({
              number: 9,
              state: 'closed',
              state_reason: 'completed',
              repository_url: 'https://api.github.com/repos/other/lib',
            }),
          ],
        },
      ),
      { owner: 'acme', repo: 'app' },
    )

    expect(dependencyRows(graph)).toEqual([])
    expect(describe_(graph, 'acme/app#5')).toBe('Issue #5. Blocked by nothing. Blocks nothing.')
  })
})

describe('dependencyRows', () => {
  it('covers every drawn edge exactly once, in a stable order', async () => {
    const graph = await buildGraph(dataFrom(arbaroIssues, arbaroBlockedBy), ARBARO)
    const rows = dependencyRows(graph)

    // Hierarchy edges are deliberately not rows: containment is not a blocking relationship.
    const drawn = graph.edges.filter((edge) => edge.kind === 'dependency')
    expect(rows).toHaveLength(drawn.length)
    expect(rows.map((row) => `${row.blocker.id}->${row.dependent.id}`).sort()).toEqual(
      drawn.map((edge) => edge.id).sort(),
    )

    // Rows sort by reference, which is repository before number: a blocker from elsewhere sorts
    // by where it lives, not by a number that means nothing outside its own repository.
    const ref = (node: { repo: string; number: number }) => [node.repo, node.number] as const
    const order = rows.map((row) => [...ref(row.blocker), ...ref(row.dependent)] as const)
    const sorted = [...order].sort(
      (a, b) =>
        String(a[0]).localeCompare(String(b[0])) ||
        Number(a[1]) - Number(b[1]) ||
        String(a[2]).localeCompare(String(b[2])) ||
        Number(a[3]) - Number(b[3]),
    )
    expect(order).toEqual(sorted)
  })

  it('grows with the edges the closed-blocker view adds', async () => {
    const open = dependencyRows(await buildGraph(dataFrom(arbaroIssues, arbaroBlockedBy), ARBARO))
    const closed = dependencyRows(
      await buildGraph(dataFrom(arbaroIssues, arbaroBlockedBy), ARBARO, { showClosed: true }),
    )

    expect(closed.length).toBeGreaterThan(open.length)
    expect(closed.some((row) => row.blocker.state === 'completed')).toBe(true)
  })
})
