import { describe, expect, it } from 'vitest'

import awBlockedBy from './__fixtures__/agent-workflows.blocked-by.json'
import awIssues from './__fixtures__/agent-workflows.issues.json'
import { adjacencyOf, dependencyRows, describeNode, issueRef } from './dependencies'
import type { IssuePayload, RepositoryGraphData } from './github'
import { buildGraph, nodeId, type IssueGraph } from './graph'

const AW = { owner: 'martonpaulo', repo: 'agent-workflows' }

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
    const graph = await buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    const adjacency = adjacencyOf(graph)

    // Every node has an entry, so "nothing blocks this" is an answer rather than a gap.
    expect(adjacency.size).toBe(graph.nodes.length)

    const pairs: string[] = []
    for (const [id, entry] of adjacency) {
      for (const blocker of entry.blockedBy) pairs.push(`${blocker.id}->${id}`)
    }
    expect(pairs.sort()).toEqual(graph.edges.map((edge) => edge.id).sort())

    // The mirror side has to agree edge for edge, or a card would announce one direction only.
    const mirrored: string[] = []
    for (const [id, entry] of adjacency) {
      for (const dependent of entry.blocks) mirrored.push(`${id}->${dependent.id}`)
    }
    expect(mirrored.sort()).toEqual(pairs.sort())
  })

  it('follows the drawn edges rather than GitHub’s own dependency counts', async () => {
    // #1 is blocked only by closed issues, so the default view draws no blocker for it even
    // though the payload still reports a total.
    const target = (awIssues as IssuePayload[]).find((candidate) => candidate.number === 1)
    expect(target?.issue_dependencies_summary?.total_blocked_by).toBeGreaterThan(0)

    const open = await buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    expect(describe_(open, nodeId('martonpaulo/agent-workflows', 1))).toContain(
      'Blocked by nothing.',
    )

    const closed = await buildGraph(dataFrom(awIssues, awBlockedBy), AW, { showClosed: true })
    expect(describe_(closed, nodeId('martonpaulo/agent-workflows', 1))).toContain(
      'Blocked by #25 and #27.',
    )
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

describe('dependencyRows', () => {
  it('covers every drawn edge exactly once, in a stable order', async () => {
    const graph = await buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    const rows = dependencyRows(graph)

    expect(rows).toHaveLength(graph.edges.length)
    expect(rows.map((row) => `${row.blocker.id}->${row.dependent.id}`).sort()).toEqual(
      graph.edges.map((edge) => edge.id).sort(),
    )

    const order = rows.map((row) => [row.blocker.number, row.dependent.number] as const)
    const sorted = [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1])
    expect(order).toEqual(sorted)
  })

  it('grows with the edges the closed-blocker view adds', async () => {
    const open = dependencyRows(await buildGraph(dataFrom(awIssues, awBlockedBy), AW))
    const closed = dependencyRows(
      await buildGraph(dataFrom(awIssues, awBlockedBy), AW, { showClosed: true }),
    )

    expect(closed.length).toBeGreaterThan(open.length)
    expect(closed.some((row) => row.blocker.state === 'completed')).toBe(true)
  })
})
