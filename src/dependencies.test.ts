import { describe, expect, it } from 'vitest'

import arbaroBlockedBy from './__fixtures__/arbaro.blocked-by.json'
import arbaroIssues from './__fixtures__/arbaro.issues.json'
import { adjacencyOf, dependencyRows, describeNode, issueRef } from './dependencies'
import type { IssuePayload, RepositoryGraphData } from './github'
import { buildGraph, nodeId, type IssueGraph } from './graph'

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

describe('a sub-issue hierarchy', () => {
  /**
   * `graph.edges` carries containment as well as ordering. Containment says which issue holds
   * another, never which comes first, and the canvas draws it without an arrowhead to say so.
   * A reader who cannot see the missing arrowhead is exactly the reader this model exists for,
   * so counting one as a blocker would mislead precisely the person it is meant to inform.
   */
  async function withParent() {
    return buildGraph(
      dataFrom(
        [
          issue({ number: 5, title: 'The parent' }),
          issue({
            number: 6,
            title: 'A sub-issue',
            parent_issue_url: 'https://api.github.com/repos/acme/app/issues/5',
          }),
          issue({ number: 7, title: 'A real blocker' }),
        ],
        { 6: [issue({ number: 7 })] },
      ),
      { owner: 'acme', repo: 'app' },
    )
  }

  it('draws the hierarchy edge, so the rest of this is a real case', async () => {
    const graph = await withParent()
    expect(graph.edges.filter((edge) => edge.kind === 'hierarchy')).toHaveLength(1)
    expect(graph.edges.filter((edge) => edge.kind === 'dependency')).toHaveLength(1)
  })

  it('never reads containment as an ordering', async () => {
    const graph = await withParent()

    // The parent contains #6; it does not block it, and #6 does not wait on it.
    expect(describe_(graph, 'acme/app#5')).toBe(
      'Issue #5. Blocked by nothing. Blocks nothing.',
    )
    // The child waits on its real blocker and on nothing else.
    expect(describe_(graph, 'acme/app#6')).toBe('Issue #6. Blocked by #7. Blocks nothing.')
    expect(describe_(graph, 'acme/app#7')).toBe('Issue #7. Blocked by nothing. Blocks #6.')
  })

  it('keeps containment out of the table of orderings', async () => {
    const rows = dependencyRows(await withParent())

    expect(rows.map((row) => `${row.blocker.id}->${row.dependent.id}`)).toEqual([
      'acme/app#7->acme/app#6',
    ])
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
