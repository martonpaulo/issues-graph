import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { App, decideSavedCopyOpen, describeSavedCopy, nextIssueSelection } from './App'
import { readCache, writeCache } from './cache'
import type { RepositoryGraphData } from './github'

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
