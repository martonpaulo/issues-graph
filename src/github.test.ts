import { describe, expect, it, vi } from 'vitest'

import rawIssue from './__fixtures__/agent-workflows.raw-issue.json'
import {
  DEPENDENCY_CONCURRENCY,
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

describe('the budget the load will spend', () => {
  it('counts only issues with an open blocker, because closed ones are not drawn', () => {
    const issues = [issue(1), issue(2, 1), issue(3, 0, 4)]
    expect(issuesNeedingBlockers(issues).map((i) => i.number)).toEqual([2])
    expect(issuesNeedingBlockers(issues, true).map((i) => i.number)).toEqual([2, 3])
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
