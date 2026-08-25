import type { LabelPayload } from './labels'
import type { RepoTarget } from './route'

/**
 * The only module that talks to GitHub.
 *
 * Everything here runs unauthenticated from the browser, which is possible because the REST issue
 * dependency endpoints are readable without a token while the GraphQL API is not. That choice is
 * what lets the viewer be a static page with no backend and no per-repository artifact.
 *
 * https://docs.github.com/en/rest/issues/issue-dependencies
 */

const API_ROOT = 'https://api.github.com'

/** Unauthenticated REST requests share one budget per IP address. */
export const UNAUTHENTICATED_HOURLY_LIMIT = 60

export interface DependencySummaryPayload {
  /** Blockers that are still open. This is what "blocked" means. */
  blocked_by: number
  /** Blockers open and closed, so a fully unblocked issue can still have a non-zero total. */
  total_blocked_by: number
  blocking: number
  total_blocking: number
}

export interface IssuePayload {
  number: number
  title: string
  state: string
  state_reason: string | null
  html_url: string
  repository_url: string
  labels: LabelPayload[]
  issue_dependencies_summary?: DependencySummaryPayload
  /** Present only on pull requests, which the issues endpoint returns alongside issues. */
  pull_request?: unknown
}

export type LoadFailure =
  | { kind: 'not-found' }
  | { kind: 'rate-limited'; reset: Date | null }
  | { kind: 'network'; message: string }
  | { kind: 'unexpected'; status: number; message: string }

export interface UnresolvedDependency {
  number: number
  reason: string
}

export interface RepositoryGraphData {
  issues: IssuePayload[]
  /** Issue number to the issues blocking it. Absent means "no blockers to fetch". */
  blockers: Map<number, IssuePayload[]>
  /** False when any dependency could not be read, so the graph must not present itself as whole. */
  complete: boolean
  unresolved: UnresolvedDependency[]
  rateLimited: boolean
  rateLimitReset: Date | null
  requestCount: number
}

export type LoadResult =
  | { ok: true; data: RepositoryGraphData }
  | { ok: false; failure: LoadFailure }

export interface LoadProgress {
  done: number
  total: number
}

export interface LoadOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  onProgress?: (progress: LoadProgress) => void
}

function rateLimitReset(response: Response): Date | null {
  const raw = response.headers.get('x-ratelimit-reset')
  if (!raw) return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null
}

/**
 * GitHub answers an exhausted budget with 403 (or 429) plus a zeroed remaining header. The status
 * alone is not enough: a 403 with budget left means something else was refused.
 */
function isRateLimited(response: Response): boolean {
  if (response.status !== 403 && response.status !== 429) return false
  return response.headers.get('x-ratelimit-remaining') === '0'
}

/** Reads the `rel="next"` target out of a Link header, which is how the REST API paginates. */
export function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim())
    if (match) return match[1]
  }
  return null
}

class RequestFailure extends Error {
  constructor(readonly failure: LoadFailure) {
    super(failure.kind)
    this.name = 'RequestFailure'
  }
}

interface RequestCounter {
  requests: number
}

/**
 * The single place a GitHub response is classified. Callers see either a usable Response or a
 * RequestFailure carrying one of the states the UI knows how to show.
 */
async function request(url: string, options: LoadOptions, count: RequestCounter): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(url, {
      signal: options.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    count.requests += 1
    throw new RequestFailure({
      kind: 'network',
      message: error instanceof Error ? error.message : 'The request could not be sent.',
    })
  }
  count.requests += 1

  if (isRateLimited(response)) {
    throw new RequestFailure({ kind: 'rate-limited', reset: rateLimitReset(response) })
  }
  if (response.status === 404) throw new RequestFailure({ kind: 'not-found' })
  if (!response.ok) {
    throw new RequestFailure({
      kind: 'unexpected',
      status: response.status,
      message: `GitHub answered ${response.status}.`,
    })
  }

  return response
}

/**
 * Lists open issues only.
 *
 * `state=all` is the obvious choice and the wrong one: martonpaulo/tabelo has 204 issues of which
 * 46 are open, so `all` costs 4 list pages plus 49 dependency requests — 53 against an
 * unauthenticated budget of 60 per hour, which a second look exhausts. Open only costs 11.
 *
 * Nothing is lost, because a closed blocker still arrives as a full issue object inside the
 * `blocked_by` payload of whatever it blocks. Closed issues therefore appear exactly when they
 * explain an edge, which is the only time a dependency graph needs them.
 */
async function listIssues(
  target: RepoTarget,
  options: LoadOptions,
  count: RequestCounter,
): Promise<IssuePayload[]> {
  const issues: IssuePayload[] = []
  let url: string | null =
    `${API_ROOT}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}` +
    `/issues?per_page=100&state=open`

  while (url) {
    const response = await request(url, options, count)
    const page = (await response.json()) as IssuePayload[]
    // The issues endpoint returns pull requests too; only a pull request carries this key.
    issues.push(...page.filter((item) => item.pull_request === undefined))
    url = nextPageUrl(response.headers.get('link'))
  }

  return issues
}

/**
 * Every dependency edge inside one repository appears as some issue's `blocked_by`, so fetching
 * only that direction yields the complete intra-repository graph. Outbound cross-repository edges
 * are deliberately not fetched: `blocking` would roughly double the request count against a 60/hour
 * unauthenticated budget, and the other repository's own graph shows the same edge.
 */
export async function loadRepositoryGraph(
  target: RepoTarget,
  options: LoadOptions = {},
): Promise<LoadResult> {
  const count = { requests: 0 }

  let issues: IssuePayload[]
  try {
    issues = await listIssues(target, options, count)
  } catch (error) {
    if (error instanceof RequestFailure) return { ok: false, failure: error.failure }
    throw error
  }

  const needBlockers = issues.filter(
    (issue) => (issue.issue_dependencies_summary?.total_blocked_by ?? 0) > 0,
  )

  const blockers = new Map<number, IssuePayload[]>()
  const unresolved: UnresolvedDependency[] = []
  let rateLimited = false
  let rateLimitReset_: Date | null = null

  options.onProgress?.({ done: 0, total: needBlockers.length })

  for (const [index, issue] of needBlockers.entries()) {
    // Once the budget is gone every further request fails the same way; stop asking and report.
    if (rateLimited) {
      unresolved.push({ number: issue.number, reason: 'rate limit reached before it was read' })
      continue
    }

    const url =
      `${API_ROOT}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}` +
      `/issues/${issue.number}/dependencies/blocked_by`

    try {
      const list = (await (await request(url, options, count)).json()) as IssuePayload[]
      blockers.set(issue.number, list)

      // Fewer blockers than GitHub's own count means something was not readable from here.
      const expected = issue.issue_dependencies_summary?.total_blocked_by ?? 0
      if (list.length < expected) {
        unresolved.push({
          number: issue.number,
          reason: `GitHub reports ${expected} blockers but returned ${list.length}`,
        })
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      if (!(error instanceof RequestFailure)) throw error

      if (error.failure.kind === 'rate-limited') {
        rateLimited = true
        rateLimitReset_ = error.failure.reset
        unresolved.push({ number: issue.number, reason: 'rate limit reached' })
      } else if (error.failure.kind === 'network') {
        unresolved.push({ number: issue.number, reason: error.failure.message })
      } else if (error.failure.kind === 'not-found') {
        unresolved.push({ number: issue.number, reason: 'dependencies were not found' })
      } else {
        unresolved.push({ number: issue.number, reason: error.failure.message })
      }
    }

    options.onProgress?.({ done: index + 1, total: needBlockers.length })
  }

  return {
    ok: true,
    data: {
      issues,
      blockers,
      complete: unresolved.length === 0,
      unresolved,
      rateLimited,
      rateLimitReset: rateLimitReset_,
      requestCount: count.requests,
    },
  }
}
