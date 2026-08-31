import { describe, expect, it, vi } from 'vitest'

import rawIssue from './__fixtures__/agent-workflows.raw-issue.json'
import {
  DEPENDENCY_CONCURRENCY,
  DEPENDENCY_PAGE_SIZE,
  dependencyRequestCost,
  issuesNeedingBlockers,
  loadRepositoryGraph,
  nextPageUrl,
  readRateLimit,
  searchRepositories,
  type IssuePayload,
} from './github'

const TARGET = { owner: 'acme', repo: 'app' }

function issue(number: number, blockedBy = 0, totalBlockedBy = blockedBy): IssuePayload {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    state_reason: null,
    html_url: `https://github.com/acme/app/issues/${number}`,
    repository_url: 'https://api.github.com/repos/acme/app',
    labels: [],
    issue_dependencies_summary: {
      blocked_by: blockedBy,
      total_blocked_by: totalBlockedBy,
      blocking: 0,
      total_blocking: 0,
    },
  }
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

const rateLimited = () =>
  json({ message: 'rate limit exceeded' }, {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1750000000' },
  })

describe('nextPageUrl', () => {
  it('finds only the next link', () => {
    const header =
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'
    expect(nextPageUrl(header)).toBe('https://api.github.com/x?page=2')
    expect(nextPageUrl('<https://api.github.com/x?page=9>; rel="last"')).toBeNull()
    expect(nextPageUrl(null)).toBeNull()
  })
})

describe('loadRepositoryGraph', () => {
  it('asks GitHub for open issues only, which is what keeps the request count affordable', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url))
      return json([issue(1)])
    })

    await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(seen[0]).toContain('state=open')
    expect(seen[0]).toContain('per_page=100')
  })

  it('follows pagination and drops pull requests', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('page=2')) return json([issue(3)])
      return json([issue(1), { ...issue(2), pull_request: { url: 'x' } }], {
        headers: { link: '<https://api.github.com/next?page=2>; rel="next"' },
      })
    })

    const result = await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.issues.map((i) => i.number)).toEqual([1, 3])
    expect(result.data.complete).toBe(true)
  })

  it('asks for dependencies only where GitHub reports some', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url))
      if (String(url).includes('/dependencies/blocked_by')) return json([issue(1)])
      return json([issue(1), issue(2, 1), issue(3)])
    })

    const result = await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const dependencyCalls = seen.filter((url) => url.includes('/dependencies/blocked_by'))
    expect(dependencyCalls).toHaveLength(1)
    expect(dependencyCalls[0]).toContain('/issues/2/dependencies/blocked_by')
    expect(result.data.requestCount).toBe(2)
  })

  it('reports a rate limit on the issue list as a failure, with the reset time', async () => {
    const fetchImpl = vi.fn(async () => rateLimited())

    const result = await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('rate-limited')
    if (result.failure.kind !== 'rate-limited') return
    expect(result.failure.reset).toEqual(new Date(1750000000 * 1000))
  })

  it('does not treat a 403 that still has budget as a rate limit', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ message: 'forbidden' }, { status: 403, headers: { 'x-ratelimit-remaining': '41' } }),
    )

    const result = await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('unexpected')
  })

  it('reports an unknown repository as not found', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'Not Found' }, { status: 404 }))

    const result = await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('not-found')
  })

  it('reports a transport error as a network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })

    const result = await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('network')
  })

  it('stops asking once the budget runs out mid-run and marks the graph incomplete', async () => {
    const blocked = Array.from({ length: DEPENDENCY_CONCURRENCY * 3 }, (_, i) => issue(i + 1, 1))
    let dependencyCalls = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/dependencies/blocked_by')) {
        dependencyCalls += 1
        return rateLimited()
      }
      return json(blocked)
    })

    const result = await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Whatever was already in flight when the first 403 came back cannot be recalled, so the run
    // spends at most one window; everything after it is reported rather than retried.
    expect(dependencyCalls).toBeLessThanOrEqual(DEPENDENCY_CONCURRENCY)
    expect(dependencyCalls).toBeLessThan(blocked.length)
    expect(result.data.rateLimited).toBe(true)
    expect(result.data.complete).toBe(false)
    expect(result.data.unresolved.map((u) => u.number)).toEqual(blocked.map((i) => i.number))
  })

  it('runs the dependency requests in parallel, bounded by the concurrency window', async () => {
    const total = DEPENDENCY_CONCURRENCY * 2
    const blocked = Array.from({ length: total }, (_, i) => issue(i + 1, 1))
    const release: (() => void)[] = []
    let inFlight = 0
    let peak = 0

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).includes('/dependencies/blocked_by')) return json(blocked)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => release.push(resolve))
      inFlight -= 1
      return json([issue(99)])
    })

    const pending = loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    // Let every worker reach its request, then answer them all.
    while (release.length < DEPENDENCY_CONCURRENCY) await Promise.resolve()
    expect(peak).toBe(DEPENDENCY_CONCURRENCY)
    let resolved = 0
    while (resolved < total) {
      const next = release[resolved]
      if (!next) {
        await Promise.resolve()
        continue
      }
      resolved += 1
      next()
    }

    const result = await pending
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.blockers.size).toBe(total)
    expect(peak).toBe(DEPENDENCY_CONCURRENCY)
  })

  it('reports every dependency failure in issue order, not completion order', async () => {
    const later: (() => void)[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target.includes('/issues/1/dependencies')) {
        // The first issue answers last, so a completion-ordered report would put it second.
        await new Promise<void>((resolve) => later.push(resolve))
        return json({}, { status: 500 })
      }
      if (target.includes('/issues/2/dependencies')) return json({}, { status: 404 })
      return json([issue(1, 1), issue(2, 1)])
    })

    const pending = loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    while (later.length < 1) await Promise.resolve()
    later[0]()

    const result = await pending
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.unresolved.map((u) => u.number)).toEqual([1, 2])
    expect(result.data.unresolved[1].reason).toBe('dependencies were not found')
  })

  it('stays complete when GitHub\'s own count disagrees with the list it returned', async () => {
    // A blocker in a repository this reader cannot see is counted in the summary and absent from
    // the list. Everything readable was read, so there is nothing to report.
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/dependencies/blocked_by')) return json([])
      return json([issue(1, 2)])
    })

    const result = await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.complete).toBe(true)
    expect(result.data.unresolved).toEqual([])
  })

  it('keeps a single dependency failure from discarding the rest of the graph', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/issues/1/dependencies')) return json({}, { status: 500 })
      if (String(url).includes('/dependencies/blocked_by')) return json([issue(9)])
      return json([issue(1, 1), issue(2, 1)])
    })

    const result = await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.blockers.get(2)).toHaveLength(1)
    expect(result.data.complete).toBe(false)
    expect(result.data.unresolved.map((u) => u.number)).toEqual([1])
  })

  it('reports progress across the dependency requests', async () => {
    const progress: number[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/dependencies/blocked_by')
        ? json([issue(9)])
        : json([issue(1, 1), issue(2, 1)]),
    )

    await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onProgress: (p) => progress.push(p.done),
    })

    expect(progress).toEqual([0, 1, 2])
  })
})

describe('paginated blockers', () => {
  const blockerPage = (from: number, size: number) =>
    Array.from({ length: size }, (_, offset) => issue(from + offset))

  /**
   * One repository whose single issue reports `count` blockers, answering the dependency endpoint
   * in pages of 100 exactly as GitHub does, with a `rel="next"` link while more remain.
   */
  const repositoryWith = (count: number, failOnPage?: number) => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      seen.push(href)
      if (!href.includes('/dependencies/blocked_by')) return json([issue(1, count)])

      const page = Number(new URL(href).searchParams.get('page') ?? '1')
      if (page === failOnPage) return json({ message: 'boom' }, { status: 500 })

      const size = Math.min(DEPENDENCY_PAGE_SIZE, Math.max(0, count - (page - 1) * DEPENDENCY_PAGE_SIZE))
      const body = blockerPage(page * 1000, size)
      const more = page * DEPENDENCY_PAGE_SIZE < count
      return json(body, {
        headers: more
          ? {
              link:
                `<https://api.github.com/repos/acme/app/issues/1/dependencies/blocked_by` +
                `?per_page=100&page=${page + 1}>; rel="next"`,
            }
          : {},
      })
    })
    return { seen, fetchImpl: fetchImpl as unknown as typeof fetch }
  }

  it('asks for the largest page GitHub allows', async () => {
    const { seen, fetchImpl } = repositoryWith(1)

    await loadRepositoryGraph(TARGET, { fetchImpl })

    const dependencyCalls = seen.filter((url) => url.includes('/dependencies/blocked_by'))
    expect(dependencyCalls).toHaveLength(1)
    expect(dependencyCalls[0]).toContain('per_page=100')
  })

  it.each([
    [0, 0, 0],
    [30, 1, 30],
    [31, 1, 31],
    [100, 1, 100],
    [101, 2, 101],
    [201, 3, 201],
  ])(
    'reads every page of %i blockers in %i request(s)',
    async (count, requests, expected) => {
      const { seen, fetchImpl } = repositoryWith(count)
      const asked: number[] = []

      const result = await loadRepositoryGraph(TARGET, {
        fetchImpl,
        confirmDependencies: (cost) => {
          asked.push(cost)
          return true
        },
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(seen.filter((url) => url.includes('/dependencies/blocked_by'))).toHaveLength(requests)
      expect(result.data.blockers.get(1) ?? []).toHaveLength(expected)
      expect(result.data.complete).toBe(true)
      // One list request plus every dependency page.
      expect(result.data.requestCount).toBe(1 + requests)
      // Nothing is asked for when nothing has a blocker.
      expect(asked).toEqual(requests === 0 ? [] : [requests])
    },
  )

  it('leaves the graph incomplete when a later page fails, rather than drawing half a list', async () => {
    const { fetchImpl } = repositoryWith(101, 2)

    const result = await loadRepositoryGraph(TARGET, { fetchImpl })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.complete).toBe(false)
    expect(result.data.blockers.has(1)).toBe(false)
    expect(result.data.unresolved).toEqual([{ number: 1, reason: 'GitHub returned error 500' }])
    expect(result.data.requestCount).toBe(3)
  })

  it('keeps one reason per issue when the dependency requests fail for different causes', async () => {
    // Three issues, three unrelated causes. The reader has to be able to tell which is which:
    // a 404 is theirs to explain, a network error is worth retrying, and a 500 is GitHub's.
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (!href.includes('/dependencies/blocked_by')) {
        return json([issue(1, 1), issue(2, 1), issue(3, 1)])
      }
      if (href.includes('/issues/1/')) throw new TypeError('Failed to fetch')
      if (href.includes('/issues/2/')) return json({ message: 'Not Found' }, { status: 404 })
      return json({ message: 'Server Error' }, { status: 500 })
    })

    const result = await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.complete).toBe(false)
    expect(result.data.unresolved).toEqual([
      { number: 1, reason: 'Failed to fetch' },
      { number: 2, reason: 'dependencies were not found' },
      { number: 3, reason: 'GitHub returned error 500' },
    ])
  })

  it('stops on a rate limit met on a later page', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      seen.push(href)
      if (!href.includes('/dependencies/blocked_by')) return json([issue(1, 101), issue(2, 1)])
      if (href.includes('page=2')) return rateLimited()
      return json(blockerPage(1000, DEPENDENCY_PAGE_SIZE), {
        headers: {
          link:
            '<https://api.github.com/repos/acme/app/issues/1/dependencies/blocked_by' +
            '?per_page=100&page=2>; rel="next"',
        },
      })
    })

    const result = await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rateLimited).toBe(true)
    expect(result.data.complete).toBe(false)
    expect(result.data.unresolved.map((u) => u.reason)).toContain('rate limit reached')
  })

  it('never spends a request the viewer did not approve, however many pages GitHub offers', async () => {
    // The summary was read before the dependency phase began; the issue grew from 100 blockers to
    // 101 in between, so GitHub now offers a second page that nobody agreed to pay for.
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      seen.push(href)
      if (!href.includes('/dependencies/blocked_by')) return json([issue(1, 100)])
      return json(blockerPage(1000, DEPENDENCY_PAGE_SIZE), {
        headers: {
          link:
            '<https://api.github.com/repos/acme/app/issues/1/dependencies/blocked_by' +
            '?per_page=100&page=2>; rel="next"',
        },
      })
    })
    const asked: number[] = []

    const result = await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      confirmDependencies: (cost) => {
        asked.push(cost)
        return true
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(asked).toEqual([1])
    // Exactly what was quoted: one list request and the one approved dependency page.
    expect(seen.filter((url) => url.includes('/dependencies/blocked_by'))).toHaveLength(1)
    expect(result.data.requestCount).toBe(2)
    // And the truncation is reported rather than drawn.
    expect(result.data.blockers.has(1)).toBe(false)
    expect(result.data.complete).toBe(false)
    expect(result.data.unresolved).toEqual([
      { number: 1, reason: 'more blockers than the approved requests could read' },
    ])
  })

  it('counts progress in pages, and reaches its total even when a page fails', async () => {
    const { fetchImpl } = repositoryWith(201, 3)
    const progress: { done: number; total: number }[] = []

    await loadRepositoryGraph(TARGET, { fetchImpl, onProgress: (p) => progress.push(p) })

    expect(progress[0]).toEqual({ done: 0, total: 3 })
    expect(progress.at(-1)).toEqual({ done: 3, total: 3 })
  })
})

describe('the budget the load will spend', () => {
  it('counts only issues with an open blocker, because closed ones are not drawn', () => {
    const issues = [issue(1), issue(2, 1), issue(3, 0, 4)]
    expect(issuesNeedingBlockers(issues).map((i) => i.number)).toEqual([2])
    expect(issuesNeedingBlockers(issues, true).map((i) => i.number)).toEqual([2, 3])
  })

  it('quotes one request per page of blockers, not one per issue', () => {
    expect(dependencyRequestCost([])).toBe(0)
    expect(dependencyRequestCost([issue(1)])).toBe(0)
    expect(dependencyRequestCost([issue(1, 1), issue(2, 100)])).toBe(2)
    expect(dependencyRequestCost([issue(1, 101)])).toBe(2)
    expect(dependencyRequestCost([issue(1, 101), issue(2, 250)])).toBe(5)
    // Closed blockers are quoted from the total, under the same switch that fetches them.
    expect(dependencyRequestCost([issue(1, 0, 150)])).toBe(0)
    expect(dependencyRequestCost([issue(1, 0, 150)], true)).toBe(2)
  })

  it('asks before spending the dependency phase, and reports the exact cost', async () => {
    const asked: number[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/dependencies/blocked_by')
        ? json([issue(9)])
        : json([issue(1, 1), issue(2, 1), issue(3)]),
    )

    const result = await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      confirmDependencies: (cost) => {
        asked.push(cost)
        return true
      },
    })

    expect(asked).toEqual([2])
    expect(result.ok).toBe(true)
  })

  it('spends nothing beyond the list when the answer is no', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url))
      return json([issue(1, 1)])
    })

    const result = await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      confirmDependencies: () => false,
    })

    expect(seen).toHaveLength(1)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('cancelled')
  })

  it('never asks when nothing has an open blocker', async () => {
    const confirm = vi.fn(() => true)
    const fetchImpl = vi.fn(async () => json([issue(1), issue(2)]))

    await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      confirmDependencies: confirm,
    })

    expect(confirm).not.toHaveBeenCalled()
  })

  it('widens the dependency phase only when closed blockers are wanted', async () => {
    const dependencyCalls = (calls: string[]) =>
      calls.filter((url) => url.includes('/dependencies/blocked_by')).length

    const run = async (includeClosed: boolean) => {
      const seen: string[] = []
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        seen.push(String(url))
        if (String(url).includes('/dependencies/blocked_by')) return json([issue(9)])
        return json([issue(1, 1), issue(2, 0, 3)])
      })
      const result = await loadRepositoryGraph(TARGET, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        includeClosed,
      })
      return { seen, result }
    }

    const narrow = await run(false)
    const wide = await run(true)

    expect(dependencyCalls(narrow.seen)).toBe(1)
    expect(dependencyCalls(wide.seen)).toBe(2)
    expect(narrow.result.ok && narrow.result.data.includedClosed).toBe(false)
    expect(wide.result.ok && wide.result.data.includedClosed).toBe(true)
  })

  it('carries the budget GitHub reported on the last response', async () => {
    const fetchImpl = vi.fn(async () =>
      json([issue(1)], {
        headers: {
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '48',
          'x-ratelimit-reset': '1750000000',
        },
      }),
    )

    const result = await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rateLimit).toEqual({
      limit: 60,
      remaining: 48,
      reset: new Date(1750000000 * 1000),
    })
  })
})

describe('readRateLimit', () => {
  it('reads the core budget', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ resources: { core: { limit: 60, remaining: 12, reset: 1750000000 } } }),
    )

    await expect(
      readRateLimit({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ limit: 60, remaining: 12, reset: new Date(1750000000 * 1000) })
  })

  it('answers null rather than failing when the probe cannot be read', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'nope' }, { status: 500 }))
    await expect(
      readRateLimit({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeNull()
  })
})

describe('searchRepositories', () => {
  it('scopes the query to an owner once one is typed', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(decodeURIComponent(String(url)))
      return json({ items: [{ full_name: 'acme/app' }, { no_name: true }] })
    })

    await expect(
      searchRepositories('acme/ap', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual(['acme/app'])
    expect(seen[0]).toContain('q=ap in:name user:acme')
  })

  it('asks for nothing on a query too short to mean anything', async () => {
    const fetchImpl = vi.fn(async () => json({ items: [] }))
    await expect(
      searchRepositories('a', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stays silent when search is throttled, so typing never surfaces an error', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'rate limited' }, { status: 403 }))
    await expect(
      searchRepositories('acme', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual([])
  })
})

describe('captured payload shape', () => {
  it('a complete GitHub issue payload still carries every field the client reads', () => {
    // Guards the projected fixtures: if GitHub renamed a consumed field, this raw capture fails.
    const payload = rawIssue as unknown as IssuePayload
    expect(typeof payload.number).toBe('number')
    expect(typeof payload.title).toBe('string')
    expect(typeof payload.state).toBe('string')
    expect(typeof payload.html_url).toBe('string')
    expect(payload.repository_url).toContain('/repos/')
    expect(Array.isArray(payload.labels)).toBe(true)
    expect(payload.issue_dependencies_summary).toBeDefined()
    expect(typeof payload.issue_dependencies_summary?.blocked_by).toBe('number')
    expect(typeof payload.issue_dependencies_summary?.total_blocked_by).toBe('number')
    expect('state_reason' in payload).toBe(true)
  })
})

/**
 * The token is the viewer's own, so the contract worth pinning is narrow: every request carries it
 * when it is set, no request mentions it when it is not, and a token GitHub rejects is reported as
 * a token problem rather than as an unexplained HTTP status.
 */
describe('the viewer’s token', () => {
  function headersOf(call: unknown): Record<string, string> {
    const init = call as { headers?: Record<string, string> }
    return init.headers ?? {}
  }

  it('sends no Authorization header when no token is set', async () => {
    const seen: Record<string, string>[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(headersOf(init))
      if (String(url).includes('/dependencies/blocked_by')) return json([issue(1)])
      return json([issue(2, 1)])
    })

    await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(seen).toHaveLength(2)
    for (const headers of seen) {
      expect(headers).not.toHaveProperty('Authorization')
      expect(headers.Accept).toBe('application/vnd.github+json')
    }
  })

  it('sends the token on the issue list and on every dependency request', async () => {
    const seen: Record<string, string>[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(headersOf(init))
      if (String(url).includes('/dependencies/blocked_by')) return json([issue(1)])
      return json([issue(2, 1), issue(3, 1)])
    })

    await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: 'github_pat_example',
    })

    expect(seen).toHaveLength(3)
    for (const headers of seen) {
      expect(headers.Authorization).toBe('Bearer github_pat_example')
    }
  })

  it('sends the token on the rate-limit pre-flight and on repository search', async () => {
    const seen: Record<string, string>[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(headersOf(init))
      if (String(url).includes('/rate_limit')) {
        return json({ resources: { core: { limit: 5000, remaining: 4999, reset: 1750000000 } } })
      }
      return json({ items: [{ full_name: 'acme/app' }] })
    })

    await readRateLimit({ fetchImpl: fetchImpl as unknown as typeof fetch, token: 'tok' })
    await searchRepositories('acme/ap', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: 'tok',
    })

    expect(seen.map((headers) => headers.Authorization)).toEqual(['Bearer tok', 'Bearer tok'])
  })

  it('ignores a token that is only whitespace, rather than sending an empty credential', async () => {
    const seen: Record<string, string>[] = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(headersOf(init))
      return json([issue(1)])
    })

    await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: '   ',
    })

    expect(seen[0]).not.toHaveProperty('Authorization')
  })

  it('reports a rejected token as its own failure, not as an unexpected status', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'Bad credentials' }, { status: 401 }))

    const result = await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: 'stale',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('bad-credentials')
  })

  it('names the rejected token when it is a dependency request that is refused', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/dependencies/blocked_by')) {
        return json({ message: 'Bad credentials' }, { status: 401 })
      }
      return json([issue(2, 1)])
    })

    const result = await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: 'stale',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.complete).toBe(false)
    expect(result.data.unresolved).toEqual([{ number: 2, reason: 'the token was rejected' }])
  })
})

/**
 * Stopping a load is what makes a token change safe: the requests still queued would otherwise
 * carry the credential the viewer has just replaced or removed.
 */
describe('abandoning a load in flight', () => {
  it('sends no further requests once the signal is aborted mid-dependency-phase', async () => {
    const controller = new AbortController()
    const seen: { url: string; token: string | undefined }[] = []

    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (controller.signal.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      const headers = (init as { headers?: Record<string, string> }).headers ?? {}
      seen.push({ url: String(url), token: headers.Authorization })

      if (String(url).includes('/dependencies/blocked_by')) {
        // The viewer removes the token while the dependency phase is running.
        controller.abort()
        return json([issue(1)])
      }
      return json([issue(2, 1), issue(3, 1), issue(4, 1)])
    })

    await expect(
      loadRepositoryGraph(TARGET, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        signal: controller.signal,
        token: 'removed-token',
      }),
    ).rejects.toThrow(DOMException)

    // The listing and the one dependency request that was already out, and nothing after them.
    const dependencyCalls = seen.filter((call) => call.url.includes('/dependencies/blocked_by'))
    expect(dependencyCalls).toHaveLength(1)
    expect(seen.every((call) => call.token === 'Bearer removed-token')).toBe(true)
  })

  it('spends nothing when the dependency phase is declined', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url))
      return json([issue(2, 1)])
    })

    const result = await loadRepositoryGraph(TARGET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: 'tok',
      confirmDependencies: () => false,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('cancelled')
    expect(seen.filter((url) => url.includes('/dependencies/blocked_by'))).toHaveLength(0)
  })
})
