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
  deriveState,
  MAX_NODE_HEIGHT,
  MAX_TITLE_LINES,
  NODE_WIDTH,
  repoOf,
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
const EDGES_TABELO = 5

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

  it('prefers closed over every open state', async () => {
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
      { id: 'other/lib#30->acme/app#5', source: 'other/lib#30', target: 'acme/app#5' },
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

/**
 * GitHub resolves `owner` and `repo` case-insensitively and serves a renamed repository through a
 * redirect, so the spelling in the address is not necessarily the spelling in the payloads. The
 * graph's identity comes from the payloads, and these cases are what that has to buy.
 *
 * https://docs.github.com/en/rest/issues/issue-dependencies
 */
describe('repository identity is canonical, not what the address happened to spell', () => {
  function blockedPair() {
    const blocked = issue({
      number: 5,
      issue_dependencies_summary: {
        blocked_by: 1,
        total_blocked_by: 1,
        blocking: 0,
        total_blocking: 0,
      },
    })
    const blocker = issue({ number: 2, title: 'Lands first' })
    return dataFrom([blocked, blocker], { 5: [blocker] })
  }

  it('draws the same graph from a mixed-case route as from the canonical one', async () => {
    // Both payloads say `acme/app`; only the address disagrees.
    const mixed = await buildGraph(blockedPair(), { owner: 'Acme', repo: 'App' })
    const exact = await buildGraph(blockedPair(), { owner: 'acme', repo: 'app' })

    expect(mixed.nodes.map((node) => node.id).sort()).toEqual(
      exact.nodes.map((node) => node.id).sort(),
    )
    expect(mixed.edges).toMatchObject([
      { id: 'acme/app#2->acme/app#5', source: 'acme/app#2', target: 'acme/app#5' },
    ])
    expect(mixed.nodes.every((node) => !node.external)).toBe(true)
  })

  it('keeps local issues local when the address spells the repository differently', async () => {
    const graph = await buildGraph(blockedPair(), { owner: 'ACME', repo: 'APP' })

    for (const node of graph.nodes) {
      expect(node.external).toBe(false)
      expect(node.repoLabel).toBe('')
      // A local card still carries workflow state; an external one has none.
      expect(node.state).not.toBeNull()
    }
  })

  it('joins the graph when a rename redirected a trusted read to another name', async () => {
    // GitHub answers `acme/old-app` under its current name, so the payloads and the address share
    // no spelling at all. A read this browser just made may say which repository it is of.
    const graph = await buildGraph(
      blockedPair(),
      { owner: 'acme', repo: 'old-app' },
      { trustedIdentity: true },
    )

    expect(graph.edges).toHaveLength(1)
    expect(graph.nodes.every((node) => !node.external)).toBe(true)
  })

  it('does not let untrusted data name the repository being drawn', async () => {
    // The shape of a crafted shared link: its path and its own slug field say `acme/app`, which is
    // all `readSnapshot` checks, while the issues inside it come from somewhere else entirely.
    // Those issues must not be drawn as this repository's own.
    const crafted = dataFrom(
      [
        issue({
          number: 5,
          repository_url: 'https://api.github.com/repos/evil/repo',
          html_url: 'https://github.com/evil/repo/issues/5',
        }),
      ],
      {},
    )

    const graph = await buildGraph(crafted, { owner: 'acme', repo: 'app' })

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({
      id: 'evil/repo#5',
      external: true,
      repoLabel: 'evil/repo',
      // An external card carries no local workflow state and no label chips.
      state: null,
      labels: [],
    })
  })

  it('still folds casing without trusting the data to name the repository', async () => {
    // The default path: the address owns the identity, and canonical comparison is what makes
    // `Acme/App` and the payloads' `acme/app` one repository rather than two.
    const graph = await buildGraph(blockedPair(), { owner: 'Acme', repo: 'App' })

    expect(graph.edges).toHaveLength(1)
    expect(graph.nodes.every((node) => !node.external)).toBe(true)
  })

  it('still qualifies a cross-repository blocker by its own repository', async () => {
    const blocked = issue({
      number: 5,
      issue_dependencies_summary: {
        blocked_by: 2,
        total_blocked_by: 2,
        blocking: 0,
        total_blocking: 0,
      },
    })
    const sibling = issue({
      number: 7,
      repository_url: 'https://api.github.com/repos/acme/other',
      html_url: 'https://github.com/acme/other/issues/7',
    })
    const foreign = issue({
      number: 30,
      repository_url: 'https://api.github.com/repos/other/lib',
      html_url: 'https://github.com/other/lib/issues/30',
    })

    const graph = await buildGraph(dataFrom([blocked], { 5: [sibling, foreign] }), {
      owner: 'Acme',
      repo: 'App',
    })

    const byNumber = new Map(graph.nodes.map((node) => [node.number, node]))
    expect(byNumber.get(7)).toMatchObject({ id: 'acme/other#7', external: true, repoLabel: 'other' })
    expect(byNumber.get(30)).toMatchObject({
      id: 'other/lib#30',
      external: true,
      repoLabel: 'other/lib',
    })
    expect(graph.edges.map((edge) => edge.id).sort()).toEqual([
      'acme/other#7->acme/app#5',
      'other/lib#30->acme/app#5',
    ])
  })

  it('draws the captured repositories whole from a mixed-case address', async () => {
    const aw = await buildGraph(dataFrom(awIssues, awBlockedBy), {
      owner: 'MartonPaulo',
      repo: 'Agent-Workflows',
    })
    expect(aw.nodes).toHaveLength(NODES_AW)
    expect(aw.edges).toHaveLength(EDGES_AW)

    const tabelo = await buildGraph(dataFrom(tabeloIssues, tabeloBlockedBy), {
      owner: 'MARTONPAULO',
      repo: 'Tabelo',
    })
    expect(tabelo.nodes).toHaveLength(NODES_TABELO)
    expect(tabelo.edges).toHaveLength(EDGES_TABELO)
    expect(tabelo.nodes.filter((node) => node.external)).toHaveLength(0)
  })
})
