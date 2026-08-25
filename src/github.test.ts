import { describe, expect, it, vi } from 'vitest'

import rawIssue from './__fixtures__/agent-workflows.raw-issue.json'
import { type IssuePayload, loadRepositoryGraph, nextPageUrl } from './github'

const TARGET = { owner: 'acme', repo: 'app' }

function issue(number: number, totalBlockedBy = 0): IssuePayload {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    state_reason: null,
    html_url: `https://github.com/acme/app/issues/${number}`,
    repository_url: 'https://api.github.com/repos/acme/app',
    labels: [],
    issue_dependencies_summary: {
      blocked_by: totalBlockedBy,
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
    let dependencyCalls = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/dependencies/blocked_by')) {
        dependencyCalls += 1
        return rateLimited()
      }
      return json([issue(1, 1), issue(2, 1), issue(3, 1)])
    })

    const result = await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // One attempt proves the budget is gone; the remaining two are reported, not retried.
    expect(dependencyCalls).toBe(1)
    expect(result.data.rateLimited).toBe(true)
    expect(result.data.complete).toBe(false)
    expect(result.data.unresolved.map((u) => u.number)).toEqual([1, 2, 3])
  })

  it('marks the graph incomplete when fewer blockers come back than GitHub counted', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/dependencies/blocked_by')) return json([])
      return json([issue(1, 2)])
    })

    const result = await loadRepositoryGraph(TARGET, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.complete).toBe(false)
    expect(result.data.unresolved[0].reason).toContain('2 blockers')
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
