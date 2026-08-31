import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import awBlockedBy from './__fixtures__/agent-workflows.blocked-by.json'
import awIssues from './__fixtures__/agent-workflows.issues.json'
import {
  abortOnTokenChange,
  App,
  budgetParts,
  decideSavedCopyOpen,
  describeSavedCopy,
  failureText,
  graphBounds,
  nextIssueSelection,
  stopsForTokenChange,
} from './App'
import { readCache, writeCache } from './cache'
import type { IssuePayload, RepositoryGraphData } from './github'
import { buildGraph, NODE_WIDTH } from './graph'

const narrowData: RepositoryGraphData = {
  issues: [],
  blockers: new Map(),
  complete: true,
  unresolved: [],
  rateLimited: false,
  rateLimitReset: null,
  requestCount: 1,
  rateLimit: null,
  includedClosed: false,
}

function withBrowserStorage<T>(run: () => T): T {
  const values = new Map<string, string>()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const localStorage: Storage = {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage,
      location: { pathname: '/dependencies/acme/app' },
    },
  })

  try {
    return run()
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

describe('nextIssueSelection', () => {
  it('replaces the selection for an ordinary issue click', () => {
    expect([...nextIssueSelection(new Set(['1', '2']), '3', false)]).toEqual(['3'])
    expect([...nextIssueSelection(new Set(['1', '2']), '2', false)]).toEqual(['2'])
  })

  it('toggles one issue for a modified click', () => {
    expect([...nextIssueSelection(new Set(['1']), '2', true)]).toEqual(['1', '2'])
    expect([...nextIssueSelection(new Set(['1', '2']), '2', true)]).toEqual(['1'])
  })
})

describe('saved copy entry', () => {
  it('keeps initial and refreshed visits at the choice gate when a copy exists', () => {
    withBrowserStorage(() => {
      writeCache('acme/app', narrowData)

      for (const visit of [1, 2]) {
        const html = renderToStaticMarkup(createElement(App))
        expect(html, `visit ${visit}`).toContain('Fetch now')
        expect(html, `visit ${visit}`).toContain('Open saved copy')
        expect(html, `visit ${visit}`).not.toContain('Issue dependency graph for acme/app')
      }
    })
  })

  it('cannot open an open-only copy as a complete closed-blocker view', () => {
    withBrowserStorage(() => {
      writeCache('acme/app', narrowData)
      const cached = readCache('acme/app')
      expect(cached).not.toBeNull()
      if (!cached) return

      expect(decideSavedCopyOpen(cached, false).kind).toBe('open')
      expect(decideSavedCopyOpen(cached, true)).toEqual({
        kind: 'requires-latest',
        reason: 'A wider GitHub read is required to include closed blockers.',
      })
      window.localStorage.setItem('issue-graph:show-closed', 'true')
      const html = renderToStaticMarkup(createElement(App))
      expect(html).toContain(
        'type="button" disabled="" aria-describedby="saved-copy-unavailable"',
      )
      expect(html).toContain('A wider GitHub read is required to include closed blockers.')
      expect(html).not.toContain('Issue dependency graph for acme/app')
      expect(
        decideSavedCopyOpen(
          { ...cached, data: { ...cached.data, includedClosed: true } },
          true,
        ).kind,
      ).toBe('open')
    })
  })

  it('describes a saved canvas with its age and dependency coverage', () => {
    const now = new Date('2026-08-30T08:00:00Z')
    const savedAt = new Date('2026-08-30T06:00:00Z')

    expect(describeSavedCopy({ savedAt, includedClosed: false }, now)).toBe(
      'Saved copy · 2 hours ago · open blockers only',
    )
    expect(describeSavedCopy({ savedAt, includedClosed: true }, now)).toBe(
      'Saved copy · 2 hours ago · includes closed blockers',
    )
  })
})

describe('graphBounds', () => {
  function dataFrom(issues: unknown, blockedBy: unknown): RepositoryGraphData {
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
    }
  }

  it('encloses every card and every group frame of a captured graph', async () => {
    const graph = await buildGraph(dataFrom(awIssues, awBlockedBy), {
      owner: 'martonpaulo',
      repo: 'agent-workflows',
    })
    const bounds = graphBounds(graph)

    expect(graph.nodes.length).toBeGreaterThan(0)
    expect(graph.groups.length).toBeGreaterThan(0)
    for (const node of graph.nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(bounds.left)
      expect(node.position.y).toBeGreaterThanOrEqual(bounds.top)
      expect(node.position.x + NODE_WIDTH).toBeLessThanOrEqual(bounds.right)
      expect(node.position.y + node.height).toBeLessThanOrEqual(bounds.bottom)
    }
    for (const group of graph.groups) {
      expect(group.position.x).toBeGreaterThanOrEqual(bounds.left)
      expect(group.position.y).toBeGreaterThanOrEqual(bounds.top)
      expect(group.position.x + group.width).toBeLessThanOrEqual(bounds.right)
      expect(group.position.y + group.height).toBeLessThanOrEqual(bounds.bottom)
    }
    expect(bounds.width).toBe(bounds.right - bounds.left)
    expect(bounds.height).toBe(bounds.bottom - bounds.top)
  })

  it('touches each edge of the box it reports', async () => {
    const graph = await buildGraph(dataFrom(awIssues, awBlockedBy), {
      owner: 'martonpaulo',
      repo: 'agent-workflows',
    })
    const bounds = graphBounds(graph)
    const boxes = [
      ...graph.nodes.map((node) => ({
        left: node.position.x,
        top: node.position.y,
        right: node.position.x + NODE_WIDTH,
        bottom: node.position.y + node.height,
      })),
      ...graph.groups.map((group) => ({
        left: group.position.x,
        top: group.position.y,
        right: group.position.x + group.width,
        bottom: group.position.y + group.height,
      })),
    ]
    expect(Math.min(...boxes.map((box) => box.left))).toBe(bounds.left)
    expect(Math.min(...boxes.map((box) => box.top))).toBe(bounds.top)
    expect(Math.max(...boxes.map((box) => box.right))).toBe(bounds.right)
    expect(Math.max(...boxes.map((box) => box.bottom))).toBe(bounds.bottom)
  })

  it('reports an empty box for a graph with nothing drawn', () => {
    const bounds = graphBounds({
      nodes: [],
      edges: [],
      groups: [],
      complete: true,
      unresolved: [],
      rateLimited: false,
      rateLimitReset: null,
      requestCount: 0,
    })
    expect(Number.isFinite(bounds.width)).toBe(false)
  })
})

/**
 * The two places a rate-limit figure reaches the reader. Both have to follow whether a token is
 * set, because quoting 60 to a viewer who supplied one understates what they can spend.
 */
describe('what the reader is told about the budget', () => {
  const target = { owner: 'acme', repo: 'app' }

  it('quotes the unauthenticated ceiling when GitHub’s numbers are unavailable', () => {
    expect(budgetParts(null, false).main).toBe('60/hour')
    expect(budgetParts(null, true).main).toBe('5000/hour')
  })

  it('prefers GitHub’s own numbers over either ceiling', () => {
    const status = { limit: 5000, remaining: 4987, reset: null }
    expect(budgetParts(status, true).main).toBe('4987/5000 left')
    expect(budgetParts(status, false).main).toBe('4987/5000 left')
  })

  it('offers a token when the limit is hit without one, and does not when it is hit with one', () => {
    const failure = { kind: 'rate-limited', reset: null } as const

    expect(failureText(target, failure, false).body).toContain('Adding a token')
    expect(failureText(target, failure, true).body).not.toContain('Adding a token')
    expect(failureText(target, failure, true).body).not.toContain('Unauthenticated')
  })

  it('says a rejected token is the thing to fix', () => {
    const text = failureText(target, { kind: 'bad-credentials' }, true)
    expect(text.title).toContain('token')
    expect(text.body).toContain('remove it')
  })
})

/**
 * A load carries the token it started with, so changing one mid-flight has to stop the other.
 * Anything that is not in flight is left alone: nothing of its is still in the air.
 */
describe('what a token change interrupts', () => {
  it('stops a read that is under way', () => {
    expect(stopsForTokenChange('listing')).toBe(true)
    expect(stopsForTokenChange('confirm')).toBe(true)
    expect(stopsForTokenChange('resolving')).toBe(true)
    expect(stopsForTokenChange('drawing')).toBe(true)
  })

  it('leaves a gate, a drawn graph, and a reported failure alone', () => {
    expect(stopsForTokenChange('gate')).toBe(false)
    expect(stopsForTokenChange('ready')).toBe(false)
    expect(stopsForTokenChange('failed')).toBe(false)
  })
})

/**
 * The abort is what actually stops requests carrying a credential the viewer has replaced, so it
 * is worth proving on its own: the component's effect is one call to this.
 */
describe('stopping a load whose token is gone', () => {
  function active(): { current: AbortController | null } {
    return { current: new AbortController() }
  }

  it('aborts what is in flight and remembers the token that replaced it', () => {
    const carried = { current: 'old' }
    const controller = active()

    expect(abortOnTokenChange(carried, 'new', controller)).toBe(true)
    expect(controller.current?.signal.aborted).toBe(true)
    expect(carried.current).toBe('new')
  })

  it('aborts when the token is removed, which is the case that leaks a credential', () => {
    const carried = { current: 'a-token' }
    const controller = active()

    expect(abortOnTokenChange(carried, '', controller)).toBe(true)
    expect(controller.current?.signal.aborted).toBe(true)
  })

  it('leaves an unchanged token alone, so an unrelated render cannot stop a load', () => {
    const carried = { current: 'same' }
    const controller = active()

    expect(abortOnTokenChange(carried, 'same', controller)).toBe(false)
    expect(controller.current?.signal.aborted).toBe(false)
  })

  it('aborts once, not on every call after the change', () => {
    const carried = { current: 'old' }
    const first = active()
    abortOnTokenChange(carried, 'new', first)

    const second = active()
    expect(abortOnTokenChange(carried, 'new', second)).toBe(false)
    expect(second.current?.signal.aborted).toBe(false)
  })

  it('does not fail when nothing is in flight', () => {
    const carried = { current: 'old' }
    const nothing = { current: null }

    expect(abortOnTokenChange(carried, 'new', nothing)).toBe(true)
    expect(carried.current).toBe('new')
  })
})
