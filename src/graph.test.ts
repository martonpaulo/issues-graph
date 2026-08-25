import { describe, expect, it } from 'vitest'

import awBlockedBy from './__fixtures__/agent-workflows.blocked-by.json'
import awIssues from './__fixtures__/agent-workflows.issues.json'
import tabeloBlockedBy from './__fixtures__/tabelo.blocked-by.json'
import tabeloIssues from './__fixtures__/tabelo.issues.json'
import type { IssuePayload, RepositoryGraphData } from './github'
import { buildGraph, deriveState, NODE_HEIGHT, NODE_WIDTH, repoOf } from './graph'

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
    ...overrides,
  }
}

const AW = { owner: 'martonpaulo', repo: 'agent-workflows' }
const TABELO = { owner: 'martonpaulo', repo: 'tabelo' }

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

describe('repoOf', () => {
  it('reads owner/name out of an API repository URL', () => {
    expect(repoOf('https://api.github.com/repos/martonpaulo/tabelo')).toBe('martonpaulo/tabelo')
  })
})

describe('deriveState', () => {
  it('uses the open-blocker count, not the total, to decide blocked', () => {
    const summary = { blocked_by: 0, total_blocked_by: 3, blocking: 0, total_blocking: 0 }
    // Every blocker has closed, so the issue is ready even though its total stays at three.
    expect(deriveState(issue({ issue_dependencies_summary: summary }))).toBe('ready')
    expect(
      deriveState(issue({ issue_dependencies_summary: { ...summary, blocked_by: 1 } })),
    ).toBe('blocked')
  })

  it('separates a completed issue from one closed as not planned', () => {
    expect(deriveState(issue({ state: 'closed', state_reason: 'completed' }))).toBe('completed')
    expect(deriveState(issue({ state: 'closed', state_reason: 'not_planned' }))).toBe('not-planned')
    expect(deriveState(issue({ state: 'closed', state_reason: null }))).toBe('completed')
  })

  it('marks an open issue carrying a status label as needing attention', () => {
    expect(deriveState(issue({ labels: [{ name: 'status: needs-decision', color: 'ededed' }] }))).toBe(
      'attention',
    )
  })

  it('prefers closed over every open state', () => {
    expect(
      deriveState(
        issue({
          state: 'closed',
          state_reason: 'completed',
          labels: [{ name: 'status: needs-decision', color: 'ededed' }],
        }),
      ),
    ).toBe('completed')
  })
})

describe('buildGraph against captured GitHub data', () => {
  it('builds the agent-workflows graph', () => {
    const graph = buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    expect(graph.nodes).toHaveLength(27)
    expect(graph.edges).toHaveLength(43)
    expect(graph.complete).toBe(true)
  })

  it('builds the tabelo graph', () => {
    const graph = buildGraph(dataFrom(tabeloIssues, tabeloBlockedBy), TABELO)
    expect(graph.nodes).toHaveLength(82)
    expect(graph.edges).toHaveLength(50)
  })

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])(
    'recovers %s closed blockers that the open-issue list never returned',
    (_name, issues, blockedBy, target) => {
      const graph = buildGraph(dataFrom(issues, blockedBy), target)
      const listed = new Set((issues as IssuePayload[]).map((issue) => issue.number))

      // The list asks only for open issues; a closed blocker reaches the graph inside the
      // dependency payload of whatever it blocks. Losing that would leave dangling edges.
      const recovered = graph.nodes.filter((node) => !listed.has(node.number))
      expect(recovered.length).toBeGreaterThan(0)
      expect(recovered.every((node) => node.state === 'completed' || node.state === 'not-planned'))
        .toBe(true)
    },
  )

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])('keeps %s structurally sound', (_name, issues, blockedBy, target) => {
    const graph = buildGraph(dataFrom(issues, blockedBy), target)
    const ids = new Set(graph.nodes.map((node) => node.id))

    for (const edge of graph.edges) {
      expect(ids.has(edge.source)).toBe(true)
      expect(ids.has(edge.target)).toBe(true)
      expect(edge.source).not.toBe(edge.target)
    }
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(graph.edges.length)
    expect(ids.size).toBe(graph.nodes.length)
  })

  it('derives blocked from GitHub rather than from the drawn edges', () => {
    const graph = buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    const byNumber = new Map((awIssues as IssuePayload[]).map((i) => [i.number, i]))

    for (const node of graph.nodes) {
      const source = byNumber.get(node.number)
      if (!source || source.state === 'closed') continue
      const openBlockers = source.issue_dependencies_summary?.blocked_by ?? 0
      expect(node.state === 'blocked').toBe(openBlockers > 0 && node.state !== 'attention')
    }
  })

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])('lays %s out in a shape a screen can show', (_name, issues, blockedBy, target) => {
    const graph = buildGraph(dataFrom(issues, blockedBy), target)
    const xs = graph.nodes.map((node) => node.position.x)
    const ys = graph.nodes.map((node) => node.position.y)
    const width = Math.max(...xs) + NODE_WIDTH - Math.min(...xs)
    const height = Math.max(...ys) + NODE_HEIGHT - Math.min(...ys)

    // Before components were packed and wide ranks wrapped, tabelo laid out at 17:1 across
    // 10112px, which is the failure this bound exists to catch.
    expect(width / height).toBeGreaterThan(0.4)
    expect(width / height).toBeLessThan(4)
  })

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])('never overlaps two %s cards', (_name, issues, blockedBy, target) => {
    const { nodes } = buildGraph(dataFrom(issues, blockedBy), target)
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i].position
        const b = nodes[j].position
        const collides =
          Math.abs(a.x - b.x) < NODE_WIDTH - 1 && Math.abs(a.y - b.y) < NODE_HEIGHT - 1
        expect(collides, `${nodes[i].id} overlaps ${nodes[j].id}`).toBe(false)
      }
    }
  })

  it('lays nodes out without stacking them all at the origin', () => {
    const graph = buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    const xs = new Set(graph.nodes.map((node) => node.position.x))
    const ys = new Set(graph.nodes.map((node) => node.position.y))
    expect(xs.size).toBeGreaterThan(1)
    expect(ys.size).toBeGreaterThan(1)
    // dagre reports centres; the transform to top-left must have happened.
    expect(Math.min(...graph.nodes.map((n) => n.position.x))).toBeGreaterThanOrEqual(
      32 - NODE_WIDTH / 2,
    )
    expect(Math.min(...graph.nodes.map((n) => n.position.y))).toBeGreaterThanOrEqual(
      32 - NODE_HEIGHT / 2,
    )
  })

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])('puts every %s blocker above what it blocks', (_name, issues, blockedBy, target) => {
    const graph = buildGraph(dataFrom(issues, blockedBy), target)
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    // Wrapping a wide rank into sub-rows must not let an edge point back up the canvas.
    for (const edge of graph.edges) {
      expect(byId.get(edge.source)!.position.y).toBeLessThan(byId.get(edge.target)!.position.y)
    }
  })

  it('keeps each dependency chain inside its own packed block', () => {
    const graph = buildGraph(dataFrom(tabeloIssues, tabeloBlockedBy), TABELO)
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    // Components are placed as rigid blocks, so an edge never spans the whole canvas.
    for (const edge of graph.edges) {
      const dx = Math.abs(byId.get(edge.source)!.position.x - byId.get(edge.target)!.position.x)
      expect(dx).toBeLessThan(3000)
    }
  })
})

describe('buildGraph edge cases not present in the captured data', () => {
  it('adds a blocker from another repository as an external node', () => {
    const local = issue({
      number: 5,
      repository_url: 'https://api.github.com/repos/acme/app',
      issue_dependencies_summary: {
        blocked_by: 1,
        total_blocked_by: 1,
        blocking: 0,
        total_blocking: 0,
      },
    })
    const foreign = issue({
      number: 30,
      title: 'Blocking from elsewhere',
      repository_url: 'https://api.github.com/repos/other/lib',
      html_url: 'https://github.com/other/lib/issues/30',
    })

    const graph = buildGraph(dataFrom([local], { 5: [foreign] }), { owner: 'acme', repo: 'app' })

    expect(graph.nodes).toHaveLength(2)
    const external = graph.nodes.find((node) => node.external)
    expect(external).toMatchObject({ number: 30, repo: 'other/lib', external: true })
    expect(graph.nodes.find((node) => node.number === 5)!.external).toBe(false)
    expect(graph.edges).toEqual([
      { id: 'other/lib#30->acme/app#5', source: 'other/lib#30', target: 'acme/app#5' },
    ])
  })

  it('ignores a dependency whose dependent issue is not in the list', () => {
    const graph = buildGraph(dataFrom([issue({ number: 1 })], { 99: [issue({ number: 2 })] }), {
      owner: 'acme',
      repo: 'app',
    })
    expect(graph.nodes).toHaveLength(1)
    expect(graph.edges).toHaveLength(0)
  })

  it('deduplicates a blocker listed twice', () => {
    const blocked = issue({
      number: 5,
      issue_dependencies_summary: {
        blocked_by: 1,
        total_blocked_by: 1,
        blocking: 0,
        total_blocking: 0,
      },
    })
    const graph = buildGraph(
      dataFrom([blocked, issue({ number: 2 })], { 5: [issue({ number: 2 }), issue({ number: 2 })] }),
      { owner: 'acme', repo: 'app' },
    )
    expect(graph.edges).toHaveLength(1)
  })

  it('carries incompleteness through to the graph so the canvas cannot claim to be whole', () => {
    const graph = buildGraph(
      dataFrom(awIssues, awBlockedBy, {
        complete: false,
        unresolved: [{ number: 9, reason: 'rate limit reached' }],
        rateLimited: true,
        rateLimitReset: new Date(1750000000 * 1000),
      }),
      AW,
    )
    expect(graph.complete).toBe(false)
    expect(graph.rateLimited).toBe(true)
    expect(graph.unresolved).toHaveLength(1)
  })
})
