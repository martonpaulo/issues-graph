import { describe, expect, it } from 'vitest'

import awBlockedBy from './__fixtures__/agent-workflows.blocked-by.json'
import awIssues from './__fixtures__/agent-workflows.issues.json'
import tabeloBlockedBy from './__fixtures__/tabelo.blocked-by.json'
import tabeloIssues from './__fixtures__/tabelo.issues.json'
import type { IssuePayload, RepositoryGraphData } from './github'
import { chipText } from './labels'
import {
  buildGraph,
  cardHeight,
  chipRows,
  dependencyCounts,
  deriveState,
  MAX_NODE_HEIGHT,
  MAX_TITLE_LINES,
  NODE_WIDTH,
  parentNodeId,
  repoOf,
  subIssuesOf,
  titleLineCount,
} from './graph'

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

const AW = { owner: 'martonpaulo', repo: 'agent-workflows' }
const TABELO = { owner: 'martonpaulo', repo: 'tabelo' }

/**
 * Sizes of the default view — open issues, closed blockers dropped. They are written down rather
 * than derived so a change in what the graph decides to draw has to be acknowledged here.
 */
const NODES_AW = 25
const EDGES_AW = 40
const NODES_TABELO = 46
/** Six `blocked_by` edges plus the two sub-issues tabelo #294 was split into. */
const EDGES_TABELO = 8
const HIERARCHY_TABELO = 2

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

describe('titleLineCount', () => {
  it('wraps on words and never asks for more than the maximum', async () => {
    expect(titleLineCount('Short title')).toBe(1)
    expect(titleLineCount('')).toBe(1)
    expect(titleLineCount('a'.repeat(33 * 3))).toBe(3)
    expect(titleLineCount('word '.repeat(200))).toBe(MAX_TITLE_LINES)
  })

  it('starts a new line rather than splitting a word across one', async () => {
    // 30 characters, then a word that cannot follow on the same line.
    expect(titleLineCount(`${'a'.repeat(30)} tail`)).toBe(2)
  })
})

describe('chipRows and cardHeight', () => {
  it('wraps the chips a card cannot fit on one line', () => {
    expect(chipRows([])).toBe(0)
    expect(chipRows(['type: bug'])).toBe(1)
    expect(chipRows(['type: bug', 'priority: P1', 'effort: L'])).toBe(1)
    // What the three slots hold on a real card, which has to stay on one row.
    expect(chipRows(['type: feature', 'priority: P2', 'effort: M'])).toBe(1)
    expect(chipRows(['type: documentation', 'priority: P1', 'effort: M'])).toBe(2)
    expect(chipRows(['a', 'b', 'c', 'd', 'e', 'f'])).toBe(1)
  })

  /**
   * The row counts asserted here were measured in a browser against `styles.css` and the shipped
   * Inter face, not derived from the estimator. The first case is the regression: its chips run to
   * 210.2px inside a 210px row, so the browser wraps them onto a second row, and a card sized for
   * one row let the `effort` chip hang below its bottom edge.
   */
  it('agrees with the browser on the combinations that wrap by a fraction of a pixel', () => {
    expect(chipRows(['type: improvement', 'priority: P2', 'effort'])).toBe(2)
    expect(chipRows(['type: improvement', 'priority: P2', 'effort: S'])).toBe(2)
    expect(chipRows(['type: documentation', 'priority: P2', 'effort'])).toBe(2)
    // Just inside the row, and must not lose the slack the case above needs.
    expect(chipRows(['type: refactor', 'priority: P3', 'effort: M'])).toBe(1)
    expect(chipRows(['type: feature', 'priority: P1', 'effort: XS'])).toBe(1)
    expect(chipRows(['type: bug', 'priority: P2', 'effort'])).toBe(1)
    expect(chipRows(['type: improvement', 'priority', 'effort'])).toBe(1)
  })

  it('reserves a second row for the chips that overflow the first, so nothing hangs out', () => {
    const overflowing = ['type: improvement', 'priority: P2', 'effort']
    // A narrower row is what the failing card effectively had: the chips do not fit, so the height
    // has to pay for the row they wrap onto.
    expect(chipRows(overflowing, 209)).toBe(2)
    expect(cardHeight(1, chipRows(overflowing))).toBeGreaterThan(cardHeight(1, 1))
  })

  it('over-reserves rather than under-reserves for text outside the captured latin subset', () => {
    // No advance is captured for these, so each one costs the widest captured glyph. Guessing narrow
    // here would be the same defect as the flat average this replaced.
    expect(chipRows(['type: 改善', 'priority: P2', 'effort'])).toBe(1)
    expect(chipRows(['type: 改善改善改善改善改善改善改善改善改善改善改善改善'])).toBe(1)
  })

  it('grows one line at a time and only spends chip rows it has chips for', () => {
    const bare = cardHeight(1, 0)
    expect(cardHeight(2, 0) - bare).toBe(cardHeight(3, 0) - cardHeight(2, 0))
    expect(cardHeight(1, 1)).toBeGreaterThan(bare)
    expect(cardHeight(1, 2)).toBeGreaterThan(cardHeight(1, 1))
    expect(cardHeight(MAX_TITLE_LINES, 2)).toBe(MAX_NODE_HEIGHT)
  })
})

describe('repoOf', () => {
  it('reads owner/name out of an API repository URL', async () => {
    expect(repoOf('https://api.github.com/repos/martonpaulo/tabelo')).toBe('martonpaulo/tabelo')
  })
})

describe('deriveState', () => {
  it('uses the open-blocker count, not the total, to decide blocked', async () => {
    const summary = { blocked_by: 0, total_blocked_by: 3, blocking: 0, total_blocking: 0 }
    // Every blocker has closed, so the issue is ready even though its total stays at three.
    expect(deriveState(issue({ issue_dependencies_summary: summary }))).toBe('ready')
    expect(
      deriveState(issue({ issue_dependencies_summary: { ...summary, blocked_by: 1 } })),
    ).toBe('blocked')
  })

  it('separates a completed issue from one closed as not planned', async () => {
    expect(deriveState(issue({ state: 'closed', state_reason: 'completed' }))).toBe('completed')
    expect(deriveState(issue({ state: 'closed', state_reason: 'not_planned' }))).toBe('not-planned')
    expect(deriveState(issue({ state: 'closed', state_reason: null }))).toBe('completed')
  })

  it('marks an open issue carrying a status label as needing attention', async () => {
    expect(deriveState(issue({ labels: [{ name: 'status: needs-decision', color: 'ededed' }] }))).toBe(
      'attention',
    )
  })

  it('reads in-review as delivered rather than as available', async () => {
    // The costly error: a change already written, rendered as something to pick up.
    expect(deriveState(issue({ labels: [{ name: 'in-review', color: '8B949E' }] }))).toBe('in-review')
    // Matched against the whole name, case-insensitively, exactly as the orchestrator matches it.
    expect(deriveState(issue({ labels: [{ name: 'In-Review', color: '8B949E' }] }))).toBe('in-review')
    expect(deriveState(issue({ labels: [{ name: 'status: in-review', color: '8B949E' }] }))).toBe(
      'attention',
    )
  })

  it('reads in-progress from the label itself, not from the status namespace', async () => {
    const inProgress = [{ name: 'in-progress', color: '8B949E' }]
    expect(deriveState(issue({ labels: inProgress }))).toBe('in-progress')

    // The pair is a parked issue, and parked is the fact worth showing. Removing either label
    // still leaves the other correct, which is what reading them independently buys.
    const parked = [...inProgress, { name: 'status: needs-decision', color: '57606A' }]
    expect(deriveState(issue({ labels: parked }))).toBe('attention')
    expect(deriveState(issue({ labels: [{ name: 'status: blocked', color: '24292F' }] }))).toBe(
      'attention',
    )
  })

  it('separates an unassigned issue from one that is free to start', async () => {
    expect(deriveState(issue({ assignees: [] }))).toBe('unassigned')
    expect(deriveState(issue({ assignees: [{ login: 'martonpaulo' }] }))).toBe('ready')
  })

  it('treats a payload carrying no assignee field as unknown rather than unassigned', async () => {
    // A cached copy or a shared snapshot written before assignees were read. It has to render as
    // whatever it used to render as, not claim that nobody is on the issue.
    expect(deriveState(issue())).toBe('ready')
  })

  it('orders the open states so the fact that decides the issue wins', async () => {
    const blocked = { blocked_by: 1, total_blocked_by: 1, blocking: 0, total_blocking: 0 }
    const every = [
      { name: 'in-review', color: '8B949E' },
      { name: 'in-progress', color: '8B949E' },
      { name: 'status: needs-decision', color: '57606A' },
    ]
    expect(
      deriveState(issue({ labels: every, assignees: [], issue_dependencies_summary: blocked })),
    ).toBe('in-review')
    expect(
      deriveState(
        issue({ labels: every.slice(1), assignees: [], issue_dependencies_summary: blocked }),
      ),
    ).toBe('attention')
    expect(
      deriveState(
        issue({ labels: every.slice(1, 2), assignees: [], issue_dependencies_summary: blocked }),
      ),
    ).toBe('in-progress')
    // Blocked outranks unassigned: nobody can pick it up, assigned or not.
    expect(deriveState(issue({ assignees: [], issue_dependencies_summary: blocked }))).toBe(
      'blocked',
    )
  })

  it('prefers closed over every open state', async () => {
    expect(
      deriveState(
        issue({
          state: 'closed',
          state_reason: 'completed',
          labels: [
            { name: 'status: needs-decision', color: 'ededed' },
            { name: 'in-review', color: '8B949E' },
          ],
          assignees: [],
        }),
      ),
    ).toBe('completed')
  })
})

describe('dependencyCounts', () => {
  it('counts ordering only, so a parent neither waits nor holds anything up', async () => {
    const graph = await buildGraph(dataFrom(tabeloIssues, tabeloBlockedBy), TABELO)
    const counted = dependencyCounts(graph.edges)

    const ordering = graph.edges.filter((edge) => edge.kind === 'dependency')
    expect(counted).toEqual({
      dependent: new Set(ordering.map((edge) => edge.target)).size,
      blocking: new Set(ordering.map((edge) => edge.source)).size,
    })
    // Dropping every hierarchy edge must not move either figure.
    expect(dependencyCounts(ordering)).toEqual(counted)
    expect(
      dependencyCounts(graph.edges.filter((edge) => edge.kind === 'hierarchy')),
    ).toEqual({ dependent: 0, blocking: 0 })
  })
})

describe('subIssuesOf', () => {
  it('reports a parent\'s progress and nothing for an issue that is not one', async () => {
    expect(
      subIssuesOf(issue({ sub_issues_summary: { total: 5, completed: 2, percent_completed: 40 } })),
    ).toEqual({ completed: 2, total: 5 })
    // GitHub sends a zeroed summary on every issue, parent or not; only a real total is progress.
    expect(
      subIssuesOf(issue({ sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 } })),
    ).toBeNull()
    expect(subIssuesOf(issue())).toBeNull()
  })
})

describe('parentNodeId', () => {
  it('reads the node a parent URL names, whatever repository it lives in', async () => {
    expect(parentNodeId('https://api.github.com/repos/martonpaulo/tabelo/issues/294')).toBe(
      'martonpaulo/tabelo#294',
    )
    expect(parentNodeId('https://api.github.com/repos/other/lib/issues/7')).toBe('other/lib#7')
  })

  it('reads nothing from an absent or unrecognized parent', async () => {
    expect(parentNodeId(null)).toBeNull()
    expect(parentNodeId(undefined)).toBeNull()
    expect(parentNodeId('https://api.github.com/repos/acme/app')).toBeNull()
  })
})

describe('buildGraph against captured GitHub data', () => {
  it('keeps the reported short-title card tight without shortening its neighbour', async () => {
    const graph = await buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    const issue12 = graph.nodes.find((node) => node.number === 12)!
    const issue13 = graph.nodes.find((node) => node.number === 13)!

    expect(issue12.title).toBe('Repair loop after a real CI failure')
    expect(issue12.titleLines).toBe(1)
    expect(chipRows(issue12.labels.map(chipText))).toBe(1)
    expect(issue12.height).toBe(cardHeight(1, 1))

    expect(issue13.title).toBe('Repair loop after changes_requested')
    expect(issue13.titleLines).toBe(2)
  })

  it('sizes every card to its own title, within the allowed range', async () => {
    const graph = await buildGraph(dataFrom(tabeloIssues, tabeloBlockedBy), TABELO)
    const heights = new Set(graph.nodes.map((node) => node.height))

    expect(heights.size).toBeGreaterThan(1)
    for (const node of graph.nodes) {
      expect(node.titleLines).toBeGreaterThanOrEqual(1)
      expect(node.titleLines).toBeLessThanOrEqual(MAX_TITLE_LINES)
      expect(node.height).toBeGreaterThanOrEqual(cardHeight(1, 0))
      expect(node.height).toBeLessThanOrEqual(cardHeight(MAX_TITLE_LINES, 3))
    }
  })

  it('builds the agent-workflows graph', async () => {
    const graph = await buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    expect(graph.nodes).toHaveLength(NODES_AW)
    expect(graph.edges).toHaveLength(EDGES_AW)
    expect(graph.complete).toBe(true)
  })

  it('reports the request cost the load actually paid', async () => {
    const graph = await buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    expect(graph.requestCount).toBeGreaterThan(0)
  })

  it('builds the tabelo graph', async () => {
    const graph = await buildGraph(dataFrom(tabeloIssues, tabeloBlockedBy), TABELO)
    expect(graph.nodes).toHaveLength(NODES_TABELO)
    expect(graph.edges).toHaveLength(EDGES_TABELO)
  })

  it('draws the tabelo split as containment, alongside the ordering it also has', async () => {
    const graph = await buildGraph(dataFrom(tabeloIssues, tabeloBlockedBy), TABELO)
    const hierarchy = graph.edges.filter((edge) => edge.kind === 'hierarchy')

    // #294 was split into #296 and #297. It also blocks #297, and that is a different assertion:
    // one edge says "contains", the other says "first". Both are drawn, neither is inferred.
    expect(hierarchy.map((edge) => edge.id).sort()).toEqual([
      'martonpaulo/tabelo#294=>martonpaulo/tabelo#296',
      'martonpaulo/tabelo#294=>martonpaulo/tabelo#297',
    ])
    expect(hierarchy).toHaveLength(HIERARCHY_TABELO)
    expect(hierarchy.every((edge) => edge.source === 'martonpaulo/tabelo#294')).toBe(true)
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === 'dependency' &&
          edge.source === 'martonpaulo/tabelo#294' &&
          edge.target === 'martonpaulo/tabelo#297',
      ),
    ).toBe(true)

    const parent = graph.nodes.find((node) => node.number === 294)!
    expect(parent.subIssues).toEqual({ completed: 0, total: 2 })
    expect(graph.nodes.filter((node) => node.subIssues !== null)).toHaveLength(1)
  })

  it('reads every tabelo card as unassigned, because none of them is assigned', async () => {
    // The whole open backlog carries an empty assignee list, which is exactly the case the state
    // exists for: unqueued work that used to render as available.
    const graph = await buildGraph(dataFrom(tabeloIssues, tabeloBlockedBy), TABELO)
    expect(new Set(graph.nodes.map((node) => node.state))).toEqual(new Set(['unassigned', 'blocked']))
  })

  it('leaves a repository captured before these fields existed exactly as it was', async () => {
    // The agent-workflows capture carries no assignees, no sub-issue summary and no parent, which
    // is what an older cached copy or a shared snapshot looks like. Nothing new may appear.
    const graph = await buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    expect(graph.edges.every((edge) => edge.kind === 'dependency')).toBe(true)
    expect(graph.nodes.every((node) => node.subIssues === null)).toBe(true)
    expect(graph.nodes.some((node) => node.state === 'ready')).toBe(true)
    expect(graph.nodes.some((node) => node.state === 'unassigned')).toBe(false)
    expect(graph.groups.every((group) => group.kind !== 'breakdown')).toBe(true)
  })

  it('omits presentation metadata from an external blocker', async () => {
    const localIssue = tabeloIssues[0] as IssuePayload
    const externalIssue = awIssues[0] as IssuePayload
    const graph = await buildGraph(
      dataFrom([localIssue], { [localIssue.number]: [externalIssue] }),
      TABELO,
    )

    const local = graph.nodes.find((node) => !node.external)!
    const external = graph.nodes.find((node) => node.external)!

    expect(external).toMatchObject({
      repo: 'martonpaulo/agent-workflows',
      repoLabel: 'agent-workflows',
      state: null,
      labels: [],
      allLabels: externalIssue.labels.map((label) => label.name),
    })
    expect(external.height).toBe(cardHeight(external.titleLines, 0))
    expect(local.state).not.toBeNull()
    expect(local.labels).not.toHaveLength(0)
    expect(graph.edges).toContainEqual({
      id: `${external.id}->${local.id}`,
      kind: 'dependency',
      source: external.id,
      target: local.id,
      points: expect.any(Array),
    })
  })

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])('draws no closed %s issue by default', async (_name, issues, blockedBy, target) => {
    const graph = await buildGraph(dataFrom(issues, blockedBy), target)
    expect(graph.nodes.some((node) => node.state === 'completed')).toBe(false)
    expect(graph.nodes.some((node) => node.state === 'not-planned')).toBe(false)
  })

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])(
    'shows %s closed blockers, which the open-issue list never returned, only when asked',
    async (_name, issues, blockedBy, target) => {
      const graph = await buildGraph(dataFrom(issues, blockedBy), target, { showClosed: true })
      const listed = new Set((issues as IssuePayload[]).map((issue) => issue.number))

      // The list asks only for open issues; a closed blocker reaches the graph inside the
      // dependency payload of whatever it blocks.
      const recovered = graph.nodes.filter((node) => !listed.has(node.number))
      expect(recovered.length).toBeGreaterThan(0)
      expect(recovered.every((node) => node.state === 'completed' || node.state === 'not-planned'))
        .toBe(true)
    },
  )

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])('frames every %s card in exactly one group', async (_name, issues, blockedBy, target) => {
    const graph = await buildGraph(dataFrom(issues, blockedBy), target)
    const framed = graph.groups.flatMap((group) => group.members)

    expect(new Set(framed).size).toBe(framed.length)
    expect(new Set(framed)).toEqual(new Set(graph.nodes.map((node) => node.id)))
    // Everything with no dependency at all belongs to the one group that says so.
    expect(graph.groups.filter((group) => group.kind === 'free').length).toBeLessThanOrEqual(1)
  })

  it('encloses every member of a group inside its frame', async () => {
    const graph = await buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))

    for (const group of graph.groups) {
      for (const id of group.members) {
        const { position } = byId.get(id)!
        expect(position.x).toBeGreaterThanOrEqual(group.position.x)
        expect(position.y).toBeGreaterThanOrEqual(group.position.y)
        expect(position.x + NODE_WIDTH).toBeLessThanOrEqual(group.position.x + group.width)
        expect(position.y + byId.get(id)!.height).toBeLessThanOrEqual(
          group.position.y + group.height,
        )
      }
    }
  })

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])('keeps %s structurally sound', async (_name, issues, blockedBy, target) => {
    const graph = await buildGraph(dataFrom(issues, blockedBy), target)
    const ids = new Set(graph.nodes.map((node) => node.id))

    for (const edge of graph.edges) {
      expect(ids.has(edge.source)).toBe(true)
      expect(ids.has(edge.target)).toBe(true)
      expect(edge.source).not.toBe(edge.target)
    }
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(graph.edges.length)
    expect(ids.size).toBe(graph.nodes.length)
  })

  it('derives blocked from GitHub rather than from the drawn edges', async () => {
    const graph = await buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    const byNumber = new Map((awIssues as IssuePayload[]).map((i) => [i.number, i]))

    for (const node of graph.nodes) {
      const source = byNumber.get(node.number)
      if (!source) continue
      const openBlockers = source.issue_dependencies_summary?.blocked_by ?? 0
      expect(node.state === 'blocked').toBe(openBlockers > 0 && node.state !== 'attention')
    }
  })

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])('lays %s out in a shape a screen can show', async (_name, issues, blockedBy, target) => {
    const graph = await buildGraph(dataFrom(issues, blockedBy), target)
    const xs = graph.nodes.map((node) => node.position.x)
    const ys = graph.nodes.map((node) => node.position.y)
    const width = Math.max(...xs) + NODE_WIDTH - Math.min(...xs)
    const height =
      Math.max(...graph.nodes.map((node) => node.position.y + node.height)) - Math.min(...ys)

    // Before components were packed and wide ranks wrapped, tabelo laid out at 17:1 across
    // 10112px, which is the failure this bound exists to catch.
    expect(width / height).toBeGreaterThan(0.4)
    expect(width / height).toBeLessThan(4)
  })

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])('never overlaps two %s cards', async (_name, issues, blockedBy, target) => {
    const { nodes } = await buildGraph(dataFrom(issues, blockedBy), target)
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]
        const b = nodes[j]
        const collides =
          a.position.x < b.position.x + NODE_WIDTH - 1 &&
          b.position.x < a.position.x + NODE_WIDTH - 1 &&
          a.position.y < b.position.y + b.height - 1 &&
          b.position.y < a.position.y + a.height - 1
        expect(collides, `${a.id} overlaps ${b.id}`).toBe(false)
      }
    }
  })

  it('lays nodes out without stacking them all at the origin', async () => {
    const graph = await buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    const xs = new Set(graph.nodes.map((node) => node.position.x))
    const ys = new Set(graph.nodes.map((node) => node.position.y))
    expect(xs.size).toBeGreaterThan(1)
    expect(ys.size).toBeGreaterThan(1)
    // The layout is normalised to the origin, never centred on it.
    expect(Math.min(...graph.nodes.map((n) => n.position.x))).toBeGreaterThanOrEqual(0)
    expect(Math.min(...graph.nodes.map((n) => n.position.y))).toBeGreaterThanOrEqual(0)
  })

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])('puts every %s blocker above what it blocks', async (_name, issues, blockedBy, target) => {
    const graph = await buildGraph(dataFrom(issues, blockedBy), target)
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    // Wrapping a wide rank into sub-rows must not let an edge point back up the canvas.
    for (const edge of graph.edges) {
      expect(byId.get(edge.source)!.position.y).toBeLessThan(byId.get(edge.target)!.position.y)
    }
  })

  it.each([
    ['agent-workflows', awIssues, awBlockedBy, AW],
    ['tabelo', tabeloIssues, tabeloBlockedBy, TABELO],
  ])('routes every %s edge orthogonally', async (_name, issues, blockedBy, target) => {
    const graph = await buildGraph(dataFrom(issues, blockedBy), target)

    for (const edge of graph.edges) {
      expect(edge.points, edge.id).toBeDefined()
      expect(edge.points!.length).toBeGreaterThanOrEqual(2)

      // Every leg runs along one axis: that is what makes the drawing read as a diagram.
      for (let index = 1; index < edge.points!.length; index += 1) {
        const from = edge.points![index - 1]
        const to = edge.points![index]
        const diagonal = Math.abs(from.x - to.x) > 0.5 && Math.abs(from.y - to.y) > 0.5
        expect(diagonal, `${edge.id} leg ${index}`).toBe(false)
      }
    }
  })

  it('gives each edge of a card its own point on it', async () => {
    const graph = await buildGraph(dataFrom(awIssues, awBlockedBy), AW)
    const leaving = new Map<string, number[]>()

    for (const edge of graph.edges) {
      leaving.set(edge.source, [...(leaving.get(edge.source) ?? []), edge.points![0].x])
    }

    const fans = [...leaving.values()].filter((xs) => xs.length > 1)
    expect(fans.length).toBeGreaterThan(0)
    for (const xs of fans) {
      expect(new Set(xs.map((x) => Math.round(x))).size).toBe(xs.length)
    }
  })

  it('keeps each dependency chain inside its own packed block', async () => {
    const graph = await buildGraph(dataFrom(tabeloIssues, tabeloBlockedBy), TABELO)
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    // Components are placed as rigid blocks, so an edge never spans the whole canvas.
    for (const edge of graph.edges) {
      const dx = Math.abs(byId.get(edge.source)!.position.x - byId.get(edge.target)!.position.x)
      expect(dx).toBeLessThan(3000)
    }
  })
})

describe('buildGraph edge cases not present in the captured data', () => {
  it('adds a blocker from another repository as an external node', async () => {
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

    const graph = await buildGraph(dataFrom([local], { 5: [foreign] }), { owner: 'acme', repo: 'app' })

    expect(graph.nodes).toHaveLength(2)
    const external = graph.nodes.find((node) => node.external)
    // A different owner keeps the whole slug; the same owner would show only the repository.
    expect(external).toMatchObject({
      number: 30,
      repo: 'other/lib',
      external: true,
      repoLabel: 'other/lib',
    })
    expect(graph.nodes.find((node) => node.number === 5)!.external).toBe(false)
    expect(graph.edges).toMatchObject([
      {
        id: 'other/lib#30->acme/app#5',
        kind: 'dependency',
        source: 'other/lib#30',
        target: 'acme/app#5',
      },
    ])
  })

  it('drops the owner from a blocker that shares it with the repository being viewed', async () => {
    const local = issue({
      number: 5,
      issue_dependencies_summary: {
        blocked_by: 1,
        total_blocked_by: 1,
        blocking: 0,
        total_blocking: 0,
      },
    })
    const sibling = issue({
      number: 7,
      repository_url: 'https://api.github.com/repos/acme/other',
      html_url: 'https://github.com/acme/other/issues/7',
    })

    const graph = await buildGraph(dataFrom([local], { 5: [sibling] }), { owner: 'acme', repo: 'app' })
    expect(graph.nodes.find((node) => node.external)!.repoLabel).toBe('other')
  })

  it('ignores a dependency whose dependent issue is not in the list', async () => {
    const graph = await buildGraph(dataFrom([issue({ number: 1 })], { 99: [issue({ number: 2 })] }), {
      owner: 'acme',
      repo: 'app',
    })
    expect(graph.nodes).toHaveLength(1)
    expect(graph.edges).toHaveLength(0)
  })

  it('drops a closed blocker and the edge into it', async () => {
    const blocked = issue({
      number: 5,
      // GitHub counts one blocker in total and none of them still open, which is exactly the
      // shape that must read as ready with no edge drawn.
      issue_dependencies_summary: {
        blocked_by: 0,
        total_blocked_by: 1,
        blocking: 0,
        total_blocking: 0,
      },
    })
    const done = issue({ number: 2, state: 'closed', state_reason: 'completed' })
    const data = dataFrom([blocked], { 5: [done] })

    const graph = await buildGraph(data, { owner: 'acme', repo: 'app' })
    expect(graph.nodes.map((node) => node.number)).toEqual([5])
    expect(graph.nodes[0].state).toBe('ready')
    expect(graph.edges).toHaveLength(0)

    const withClosed = await buildGraph(data, { owner: 'acme', repo: 'app' }, { showClosed: true })
    expect(withClosed.nodes.map((node) => node.number).sort()).toEqual([2, 5])
    expect(withClosed.edges).toHaveLength(1)
  })

  it('deduplicates a blocker listed twice', async () => {
    const blocked = issue({
      number: 5,
      issue_dependencies_summary: {
        blocked_by: 1,
        total_blocked_by: 1,
        blocking: 0,
        total_blocking: 0,
      },
    })
    const graph = await buildGraph(
      dataFrom([blocked, issue({ number: 2 })], { 5: [issue({ number: 2 }), issue({ number: 2 })] }),
      { owner: 'acme', repo: 'app' },
    )
    expect(graph.edges).toHaveLength(1)
  })

  it('draws a sub-issue as containment, from the child, at no request cost', async () => {
    const parent = issue({
      number: 5,
      sub_issues_summary: { total: 2, completed: 1, percent_completed: 50 },
    })
    const child = issue({
      number: 6,
      parent_issue_url: 'https://api.github.com/repos/acme/app/issues/5',
    })

    const graph = await buildGraph(dataFrom([parent, child], {}), { owner: 'acme', repo: 'app' })

    expect(graph.edges).toMatchObject([
      { id: 'acme/app#5=>acme/app#6', kind: 'hierarchy', source: 'acme/app#5', target: 'acme/app#6' },
    ])
    expect(graph.nodes.find((node) => node.number === 5)!.subIssues).toEqual({
      completed: 1,
      total: 2,
    })
    expect(graph.nodes.find((node) => node.number === 6)!.subIssues).toBeNull()
  })

  it('frames a containment-only set as a breakdown rather than as a chain', async () => {
    const parent = issue({
      number: 5,
      sub_issues_summary: { total: 1, completed: 0, percent_completed: 0 },
    })
    const child = issue({
      number: 6,
      parent_issue_url: 'https://api.github.com/repos/acme/app/issues/5',
    })

    const graph = await buildGraph(dataFrom([parent, child], {}), { owner: 'acme', repo: 'app' })

    // A parent and its children have no order between them, so calling the frame a chain would
    // assert the one thing containment does not say.
    expect(graph.groups).toMatchObject([{ kind: 'breakdown', label: 'Breakdown · 2 issues' }])
  })

  it('drops a parent that lives in another repository instead of fetching it', async () => {
    // Several of this owner's sub-issues point at a parent in a different repository. Reaching it
    // would cost the outbound request `blocking` is deliberately not spending either.
    const child = issue({
      number: 6,
      parent_issue_url: 'https://api.github.com/repos/other/lib/issues/9',
    })

    const graph = await buildGraph(dataFrom([child], {}), { owner: 'acme', repo: 'app' })
    expect(graph.nodes).toHaveLength(1)
    expect(graph.edges).toHaveLength(0)
  })

  it('drops a parent whose issue is closed and therefore not drawn', async () => {
    const child = issue({
      number: 6,
      parent_issue_url: 'https://api.github.com/repos/acme/app/issues/5',
    })
    const closedParent = issue({ number: 5, state: 'closed', state_reason: 'completed' })

    const graph = await buildGraph(dataFrom([closedParent, child], {}), {
      owner: 'acme',
      repo: 'app',
    })
    expect(graph.nodes.map((node) => node.number)).toEqual([6])
    expect(graph.edges).toHaveLength(0)
  })

  it('carries incompleteness through to the graph so the canvas cannot claim to be whole', async () => {
    const graph = await buildGraph(
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
