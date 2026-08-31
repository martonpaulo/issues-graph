import { beforeEach, describe, expect, it } from 'vitest'

import { readCache, writeCache } from './cache'
import tabeloBlockedBy from './__fixtures__/tabelo.blocked-by.json'
import tabeloIssues from './__fixtures__/tabelo.issues.json'
import type { IssuePayload, RepositoryGraphData } from './github'

/**
 * The tests run under the `node` environment, so `window.localStorage` has to be supplied. The
 * store is a plain map: what matters here is what cache.ts round-trips through it, not the
 * browser's own quota or eviction behavior.
 */
function installStorage(overrides: Partial<Storage> = {}): Map<string, string> {
  const entries = new Map<string, string>()
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    ...overrides,
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  })
  return entries
}

const issues = tabeloIssues as IssuePayload[]
const blockers = new Map(
  Object.entries(tabeloBlockedBy as Record<string, IssuePayload[]>).map(([number, list]) => [
    Number(number),
    list,
  ]),
)

function graph(overrides: Partial<RepositoryGraphData> = {}): RepositoryGraphData {
  return {
    issues,
    blockers,
    complete: true,
    unresolved: [],
    rateLimited: false,
    rateLimitReset: null,
    requestCount: 1 + blockers.size,
    rateLimit: null,
    includedClosed: false,
    ...overrides,
  }
}

let entries: Map<string, string>

beforeEach(() => {
  entries = installStorage()
})

describe('readCache', () => {
  it('returns nothing for a repository that was never saved', () => {
    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  it('reads back the graph a write saved', () => {
    writeCache('martonpaulo/tabelo', graph({ complete: false, includedClosed: true }))
    const cached = readCache('martonpaulo/tabelo')

    expect(cached).not.toBeNull()
    expect(cached?.data.issues.map((issue) => issue.number)).toEqual(
      issues.map((issue) => issue.number),
    )
    expect([...(cached?.data.blockers.keys() ?? [])]).toEqual([...blockers.keys()])
    expect(cached?.data.blockers.get([...blockers.keys()][0])?.map((issue) => issue.number)).toEqual(
      blockers.get([...blockers.keys()][0])?.map((issue) => issue.number),
    )
    expect(cached?.data.complete).toBe(false)
    expect(cached?.data.includedClosed).toBe(true)
    expect(cached?.data.requestCount).toBe(1 + blockers.size)
  })

  it('carries the unresolved dependencies that made a graph incomplete', () => {
    writeCache(
      'martonpaulo/tabelo',
      graph({ complete: false, unresolved: [{ number: 49, reason: 'network' }] }),
    )
    expect(readCache('martonpaulo/tabelo')?.data.unresolved).toEqual([
      { number: 49, reason: 'network' },
    ])
  })

  it('reports when the copy was saved, as a Date', () => {
    const before = Date.now()
    writeCache('martonpaulo/tabelo', graph())
    const savedAt = readCache('martonpaulo/tabelo')?.savedAt

    expect(savedAt).toBeInstanceOf(Date)
    expect(savedAt?.getTime()).toBeGreaterThanOrEqual(before)
    expect(savedAt?.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('never presents the saved budget as the budget now', () => {
    writeCache(
      'martonpaulo/tabelo',
      graph({
        rateLimited: true,
        rateLimitReset: new Date('2026-01-01T00:00:00Z'),
        rateLimit: { limit: 60, remaining: 0, reset: new Date('2026-01-01T00:00:00Z') },
      }),
    )
    const cached = readCache('martonpaulo/tabelo')

    expect(cached?.data.rateLimited).toBe(false)
    expect(cached?.data.rateLimitReset).toBeNull()
    expect(cached?.data.rateLimit).toBeNull()
  })

  it('ignores a copy written by an older format', () => {
    writeCache('martonpaulo/tabelo', graph())
    const [key, raw] = [...entries][0]
    entries.set(key, JSON.stringify({ ...JSON.parse(raw), version: 0 }))

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  it('keeps one repository from reading another repository’s copy', () => {
    writeCache('martonpaulo/tabelo', graph())

    expect(readCache('martonpaulo/agent-workflows')).toBeNull()
    expect(readCache('martonpaulo/tabelo')).not.toBeNull()
  })

  it('returns nothing rather than throwing when storage is unreadable', () => {
    installStorage({
      getItem: () => {
        throw new Error('storage blocked')
      },
    })

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })
})

describe('writeCache', () => {
  it('stores only the fields the graph consumes, so the quota holds', () => {
    writeCache('martonpaulo/tabelo', graph())
    const stored = JSON.parse([...entries.values()][0])

    expect(Object.keys(stored.issues[0]).sort()).toEqual(
      [
        'assignees',
        'html_url',
        'issue_dependencies_summary',
        'labels',
        'number',
        'parent_issue_url',
        'repository_url',
        'state',
        'state_reason',
        'sub_issues_summary',
        'title',
      ].sort(),
    )
    expect(Object.keys(stored.issues[0].labels[0]).sort()).toEqual(['color', 'name'])
    // The login and nothing else: GitHub's user object is several hundred bytes per issue that
    // nothing reads, and this projection is what keeps a copy inside the storage quota.
    const parent = stored.issues.find((issue: { number: number }) => issue.number === 294)
    expect(parent.sub_issues_summary).toEqual({ total: 2, completed: 0, percent_completed: 0 })
    const child = stored.issues.find((issue: { number: number }) => issue.number === 296)
    expect(child.parent_issue_url).toBe('https://api.github.com/repos/martonpaulo/tabelo/issues/294')
  })

  it('round-trips a copy written before assignees and sub-issues were read', () => {
    // `version` stays at 1 because the shape is a superset: an older copy must still parse and
    // still derive the states it used to derive.
    const older = issues.map((issue) => {
      const copy = { ...issue }
      delete copy.assignees
      delete copy.sub_issues_summary
      delete copy.parent_issue_url
      return copy
    })
    writeCache('martonpaulo/tabelo', graph({ issues: older, blockers: new Map() }))

    const read = readCache('martonpaulo/tabelo')!
    expect(read.data.issues[0].assignees).toBeUndefined()
    expect(read.data.issues).toHaveLength(older.length)
  })

  it('drops a payload field the graph does not read', () => {
    const withExtra = [{ ...issues[0], pull_request: { url: 'https://example.invalid' } }]
    writeCache('martonpaulo/tabelo', graph({ issues: withExtra, blockers: new Map() }))

    expect([...entries.values()][0]).not.toContain('pull_request')
    expect(readCache('martonpaulo/tabelo')?.data.issues[0].number).toBe(issues[0].number)
  })

  it('replaces the previous copy of the same repository', () => {
    writeCache('martonpaulo/tabelo', graph())
    writeCache('martonpaulo/tabelo', graph({ issues: [issues[0]], blockers: new Map() }))

    expect(entries.size).toBe(1)
    expect(readCache('martonpaulo/tabelo')?.data.issues).toHaveLength(1)
  })

  it('stays silent when storage refuses the write', () => {
    installStorage({
      setItem: () => {
        throw new Error('quota exceeded')
      },
    })

    expect(() => writeCache('martonpaulo/tabelo', graph())).not.toThrow()
  })
})
