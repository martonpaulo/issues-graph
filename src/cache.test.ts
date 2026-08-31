import { beforeEach, describe, expect, it } from 'vitest'

import { readCache, writeCache } from './cache'
import { cacheKey, dimmedKey, retained } from './retention'
import tabeloBlockedBy from './__fixtures__/tabelo.blocked-by.json'
import tabeloIssues from './__fixtures__/tabelo.issues.json'
import type { IssuePayload, RepositoryGraphData } from './github'

/**
 * The tests run under the `node` environment, so `window.localStorage` has to be supplied. The
 * store is a plain map: what matters here is what cache.ts round-trips through it, not the
 * browser's own quota or eviction behavior.
 */
function installStorage(
  overrides: Partial<Storage> = {},
  existing?: Map<string, string>,
): Map<string, string> {
  const entries = existing ?? new Map<string, string>()
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

  /* Schema drift: a copy written by a build with a different idea of the shape, or edited by
     hand in devtools. Every one of these parses as JSON, so only a structural check catches it,
     and the failure it prevents happens in the layout rather than here. */

  function corrupt(change: (stored: Record<string, unknown>) => void): void {
    writeCache('martonpaulo/tabelo', graph())
    const key = 'issue-graph:cache:martonpaulo/tabelo'
    const stored = JSON.parse(entries.get(key) as string) as Record<string, unknown>
    change(stored)
    entries.set(key, JSON.stringify(stored))
  }

  it('ignores a copy whose issues are not an array', () => {
    corrupt((stored) => {
      stored.issues = { 0: { number: 1 } }
    })

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  it('ignores a copy holding an issue that lost a field the cards read', () => {
    corrupt((stored) => {
      delete (stored.issues as Record<string, unknown>[])[0].html_url
    })

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  /* The dependency summary is nested two levels down and is the field the drawing depends on
     most: `graph.ts` reads `blocked_by` to decide blocked or ready, and the quote reads
     `total_blocked_by` to price the dependency phase. Both go through `?? 0`, which catches an
     absent summary but not a present one holding the wrong type. */

  it('ignores a copy whose summary count is a container rather than a number', () => {
    corrupt((stored) => {
      ;(stored.issues as Record<string, unknown>[])[0].issue_dependencies_summary = {
        blocked_by: [],
        total_blocked_by: 0,
        blocking: 0,
        total_blocking: 0,
      }
    })

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  it('ignores a copy whose summary lost one of its counts', () => {
    corrupt((stored) => {
      ;(stored.issues as Record<string, unknown>[])[0].issue_dependencies_summary = {
        blocked_by: 2,
        blocking: 0,
        total_blocking: 0,
      }
    })

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  it('ignores a copy whose summary counts something a fraction or a negative number of times', () => {
    corrupt((stored) => {
      ;(stored.issues as Record<string, unknown>[])[0].issue_dependencies_summary = {
        blocked_by: -1,
        total_blocked_by: 1.5,
        blocking: 0,
        total_blocking: 0,
      }
    })

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  // GitHub omits the summary for an issue with no dependencies at all, so absent stays valid.
  // Only a summary that is present has to be whole.
  it('reads back an issue that carries no summary at all', () => {
    corrupt((stored) => {
      delete (stored.issues as Record<string, unknown>[])[0].issue_dependencies_summary
    })

    expect(readCache('martonpaulo/tabelo')?.data.issues[0].issue_dependencies_summary).toBeUndefined()
  })

  it('ignores a copy whose blockers are no longer number-to-issues tuples', () => {
    corrupt((stored) => {
      stored.blockers = [['49', []]]
    })

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  it('ignores a copy whose includedClosed is not a boolean', () => {
    corrupt((stored) => {
      stored.includedClosed = 'true'
    })

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  it('ignores a copy whose unresolved entries lost their reason', () => {
    corrupt((stored) => {
      stored.unresolved = [{ number: 49 }]
    })

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  // Finite is not enough: the ECMAScript time range is ±8.64e15 ms, and 1e20 yields an Invalid
  // Date that the banner would render as `NaN days ago`.
  it('ignores a copy whose savedAt is outside the range a Date can hold', () => {
    corrupt((stored) => {
      stored.savedAt = 1e20
    })

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  it('ignores a copy written by a version this build does not know', () => {
    corrupt((stored) => {
      stored.version = 2
    })

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  it('ignores text that is not JSON at all', () => {
    writeCache('martonpaulo/tabelo', graph())
    const [key] = [...entries][0]
    entries.set(key, 'not json')

    expect(readCache('martonpaulo/tabelo')).toBeNull()
  })

  // The cache is reconstructible from GitHub, so an unreadable copy is ignored rather than
  // deleted: removing a value this build merely fails to understand would destroy one another
  // build still reads, and nothing here touches a key it did not read.
  it('leaves the copy it refused, and every other key, in place', () => {
    entries.set('issue-graph:unrelated', '"kept"')
    corrupt((stored) => {
      stored.version = 2
    })
    const before = new Map(entries)

    expect(readCache('martonpaulo/tabelo')).toBeNull()
    expect([...entries]).toEqual([...before])
  })

  it('keeps one repository from reading another repository’s copy', () => {
    writeCache('martonpaulo/tabelo', graph())

    expect(readCache('martonpaulo/arbaro')).toBeNull()
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

    expect(entries.get('issue-graph:cache:martonpaulo/tabelo')).not.toContain('pull_request')
    expect(readCache('martonpaulo/tabelo')?.data.issues[0].number).toBe(issues[0].number)
  })

  it('replaces the previous copy of the same repository', () => {
    writeCache('martonpaulo/tabelo', graph())
    writeCache('martonpaulo/tabelo', graph({ issues: [issues[0]], blockers: new Map() }))

    // The retention index is the only other key: one saved copy, not two.
    expect([...entries.keys()].filter((key) => key.startsWith('issue-graph:cache:'))).toEqual([
      'issue-graph:cache:martonpaulo/tabelo',
    ])
    expect(readCache('martonpaulo/tabelo')?.data.issues).toHaveLength(1)
  })

  it('records the size of the copy it saved, so the budget has something to measure', () => {
    writeCache('martonpaulo/tabelo', graph())

    const held = retained()[0]
    expect(held.slug).toBe('martonpaulo/tabelo')
    expect(held.chars).toBe(entries.get(cacheKey('martonpaulo/tabelo'))?.length)
  })

  /* A full quota is not a dead end while an older repository is still holding space. What is
     surrendered is reconstructible from GitHub; what is being written is the read the viewer just
     paid for. */

  it('gives up an older repository and saves the copy the reader just paid for', () => {
    entries.set(cacheKey('o/old'), 'x'.repeat(50))
    entries.set(dimmedKey('o/old'), '["issue-1"]')
    writeCache('o/old', graph({ issues: [issues[0]], blockers: new Map() }))

    // The next write is refused until the older repository's copy is gone.
    installStorage(
      {
        setItem: (key: string, value: string) => {
          if (key.startsWith('issue-graph:cache:') && entries.has(cacheKey('o/old'))) {
            throw new DOMException('exceeded', 'QuotaExceededError')
          }
          entries.set(key, value)
        },
      },
      entries,
    )

    expect(writeCache('martonpaulo/tabelo', graph())).toEqual({ ok: true })
    expect(entries.has(cacheKey('o/old'))).toBe(false)
    expect(entries.has(dimmedKey('o/old'))).toBe(false)
    expect(readCache('martonpaulo/tabelo')).not.toBeNull()
  })

  it('reports a quota it cannot free rather than looping', () => {
    writeCache('martonpaulo/tabelo', graph())
    installStorage(
      {
        setItem: (key: string) => {
          if (key.startsWith('issue-graph:cache:')) {
            throw new DOMException('exceeded', 'QuotaExceededError')
          }
        },
      },
      entries,
    )

    expect(writeCache('martonpaulo/tabelo', graph())).toMatchObject({ reason: 'quota' })
  })

  it('reports the refusal rather than throwing when storage will not take the write', () => {
    installStorage({
      setItem: () => {
        throw new Error('storage is blocked')
      },
    })

    expect(writeCache('martonpaulo/tabelo', graph())).toEqual({
      ok: false,
      reason: 'unavailable',
      message: 'This browser is not letting the page save anything.',
    })
  })
})
