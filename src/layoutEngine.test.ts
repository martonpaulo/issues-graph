import { beforeEach, describe, expect, it, vi } from 'vitest'

import awBlockedBy from './__fixtures__/agent-workflows.blocked-by.json'
import awIssues from './__fixtures__/agent-workflows.issues.json'
import type { IssuePayload, RepositoryGraphData } from './github'

/**
 * The engine's lifecycle, which the real ELK cannot be made to fail on demand.
 *
 * `graph.ts` memoizes the engine for the session, so its failure behavior is only observable
 * across several calls: the point of the fix is that call two does not inherit call one's
 * rejection. That needs an engine whose initialization can be made to fail exactly once, which is
 * why this file substitutes ELK rather than sharing `graph.test.ts`'s real one.
 */
const elk = vi.hoisted(() => ({ constructions: 0, layouts: 0, failNext: false }))

vi.mock('elkjs/lib/elk.bundled.js', () => {
  interface FakeNode {
    id: string
    width?: number
    height?: number
    x?: number
    y?: number
    children?: FakeNode[]
    edges?: { id: string; sources: string[]; targets: string[] }[]
  }

  class FakeElk {
    constructor() {
      elk.constructions += 1
      if (elk.failNext) {
        elk.failNext = false
        // The shape a failed chunk load actually takes in a browser.
        throw new Error('Failed to fetch dynamically imported module')
      }
    }

    layout(graph: FakeNode): Promise<FakeNode> {
      elk.layouts += 1
      // Positions are irrelevant here — this file is about the engine's lifecycle, and
      // `graph.test.ts` already holds every assertion about where cards land.
      return Promise.resolve({
        ...graph,
        children: (graph.children ?? []).map((child, index) => ({ ...child, x: 0, y: index * 100 })),
        edges: [],
      })
    }
  }

  return { default: FakeElk }
})

const AW = { owner: 'martonpaulo', repo: 'agent-workflows' }

function data(): RepositoryGraphData {
  const blockers = new Map(
    Object.entries(awBlockedBy as Record<string, IssuePayload[]>).map(([number, list]) => [
      Number(number),
      list,
    ]),
  )
  return {
    issues: awIssues as IssuePayload[],
    blockers,
    complete: true,
    unresolved: [],
    rateLimited: false,
    rateLimitReset: null,
    requestCount: 1 + blockers.size,
    rateLimit: null,
    includedClosed: true,
  }
}

/**
 * A fresh module registry per test, because the memoized engine is module state. Resetting it here
 * rather than exporting a reset function keeps the retry path free of an entry point that only a
 * test would ever call.
 */
async function freshGraph() {
  vi.resetModules()
  elk.constructions = 0
  elk.layouts = 0
  elk.failNext = false
  return import('./graph')
}

describe('a failed layout engine can be retried', () => {
  beforeEach(() => {
    elk.failNext = false
  })

  it('does not keep a rejected engine, so the next draw builds a new one', async () => {
    const { buildGraph } = await freshGraph()

    elk.failNext = true
    await expect(buildGraph(data(), AW)).rejects.toThrow(
      'Failed to fetch dynamically imported module',
    )

    const graph = await buildGraph(data(), AW)

    expect(graph.nodes.length).toBeGreaterThan(0)
    expect(elk.constructions).toBe(2)
  })

  it('reuses the engine it kept, so a retry costs one initialization and no more', async () => {
    const { buildGraph } = await freshGraph()

    elk.failNext = true
    await expect(buildGraph(data(), AW)).rejects.toThrow()

    await buildGraph(data(), AW)
    await buildGraph(data(), AW)

    // One failure, one replacement, and nothing built for the draw that reused it.
    expect(elk.constructions).toBe(2)
    expect(elk.layouts).toBe(2)
  })

  it('rejects every draw that shares the failing attempt, and only those', async () => {
    const { buildGraph } = await freshGraph()

    elk.failNext = true
    // Started together, so both hold the same in-flight engine Promise: both must fail, and the
    // one started afterwards must not.
    const [first, second] = await Promise.allSettled([buildGraph(data(), AW), buildGraph(data(), AW)])

    expect(first.status).toBe('rejected')
    expect(second.status).toBe('rejected')
    expect(elk.constructions).toBe(1)

    await expect(buildGraph(data(), AW)).resolves.toBeTruthy()
    expect(elk.constructions).toBe(2)
  })
})

describe('drawFailure', () => {
  it('carries the reason the layout gave', async () => {
    const { drawFailure } = await freshGraph()

    expect(drawFailure(new Error('Failed to fetch dynamically imported module'))).toEqual({
      kind: 'draw',
      message: 'Failed to fetch dynamically imported module',
    })
  })

  it('still names a cause when something other than an Error was thrown', async () => {
    const { drawFailure } = await freshGraph()

    expect(drawFailure('boom')).toEqual({ kind: 'draw', message: 'The layout failed.' })
  })
})
