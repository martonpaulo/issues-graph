import type { LabelPayload } from './labels'
import type { RepoTarget } from './route'

/**
 * The only module that talks to GitHub.
 *
 * Everything here works unauthenticated from the browser, which is possible because the REST issue
 * dependency endpoints are readable without a token while the GraphQL API is not. That choice is
 * what lets the viewer be a static page with no backend and no per-repository artifact.
 *
 * A viewer may supply their own token to raise their rate limit; it arrives through `LoadOptions`
 * and this module never learns where it is kept. Requests without one are unchanged.
 *
 * https://docs.github.com/en/rest/issues/issue-dependencies
 */

const API_ROOT = 'https://api.github.com'

/**
 * Unauthenticated REST requests share one budget per IP address. Used only as the figure to quote
 * when GitHub's own numbers could not be read; the live budget always comes from `readRateLimit`
 * or from the headers of a real response.
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 */
export const UNAUTHENTICATED_HOURLY_LIMIT = 60

/**
 * The same budget for a request carrying a token, which belongs to the viewer rather than to an
 * IP address. Quoted on the same terms as the unauthenticated figure: only when GitHub's own
 * numbers could not be read.
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 */
export const AUTHENTICATED_HOURLY_LIMIT = 5000

/**
 * How many dependency requests are in flight at once.
 *
 * They are independent reads, so awaiting each one before sending the next made the phase take as
 * long as the sum of its round trips: a graph needing 30 of them waited for 30 sequential responses.
 * The width stays small on purpose. GitHub asks clients to keep concurrency modest and answers a
 * burst with a secondary rate limit, and a narrow window also bounds how many requests a run can
 * have in the air before the first exhausted-budget response stops the rest.
 * https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
 */
export const DEPENDENCY_CONCURRENCY = 6

export interface RateLimitStatus {
  limit: number
  remaining: number
  reset: Date | null
}

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
  | { kind: 'bad-credentials' }
  | { kind: 'network'; message: string }
  | { kind: 'unexpected'; status: number; message: string }
  | { kind: 'cancelled' }

export interface UnresolvedDependency {
  number: number
  reason: string
}

export interface RepositoryGraphData {
  issues: IssuePayload[]
  /** Issue number to the issues blocking it. Absent means "no open blockers to fetch". */
  blockers: Map<number, IssuePayload[]>
  /** False when a dependency request actually failed, so the graph must not present itself as whole. */
  complete: boolean
  unresolved: UnresolvedDependency[]
  rateLimited: boolean
  rateLimitReset: Date | null
  requestCount: number
  /** The budget as GitHub reported it on the last response, so the canvas can show what is left. */
  rateLimit: RateLimitStatus | null
  /** True when the dependency requests covered closed blockers as well as open ones. */
  includedClosed: boolean
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
  /**
   * The viewer's own GitHub token. Present means every request this call makes is authenticated
   * and draws on their 5000/hour budget; absent means the request is exactly what it was before
   * tokens existed.
   */
  token?: string
  signal?: AbortSignal
  onProgress?: (progress: LoadProgress) => void
  /**
   * Widens the dependency phase to every issue that has ever been blocked, which is what it takes
   * to draw closed blockers. It costs more requests, so it follows the viewer's "show closed"
   * switch rather than being on by default.
   */
  includeClosed?: boolean
  /**
   * Asked once, after the issue list is in and before a single dependency request is sent, with
   * the exact number of requests that phase will cost. Returning false abandons the load.
   *
   * The budget is small and shared per IP address, so spending it is the user's decision to make
   * with a real number in front of them rather than a guess made before anything was listed.
   */
  confirmDependencies?: (cost: number) => boolean | Promise<boolean>
}

/**
 * The one place a request's headers are built, so a new request site cannot be added that quietly
 * forgets to authenticate.
 * https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api
 */
function headersFor(options: LoadOptions): HeadersInit {
  const token = options.token?.trim()
  return token
    ? { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }
    : { Accept: 'application/vnd.github+json' }
}

function parseReset(raw: string | null): Date | null {
  if (!raw) return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null
}

function statusFrom(response: Response): RateLimitStatus | null {
  const limit = Number(response.headers.get('x-ratelimit-limit'))
  const remaining = Number(response.headers.get('x-ratelimit-remaining'))
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return null
  return { limit, remaining, reset: parseReset(response.headers.get('x-ratelimit-reset')) }
}

/**
 * Reads the current budget without spending any of it.
 *
 * https://docs.github.com/en/rest/rate-limit/rate-limit — "Accessing this endpoint does not count
 * against your REST API rate limit." That is what makes it usable as a pre-flight check.
 */
export async function readRateLimit(options: LoadOptions = {}): Promise<RateLimitStatus | null> {
  const doFetch = options.fetchImpl ?? fetch
  try {
    const response = await doFetch(`${API_ROOT}/rate_limit`, {
      signal: options.signal,
      headers: headersFor(options),
    })
    if (!response.ok) return null
    const body = (await response.json()) as {
      resources?: { core?: { limit?: number; remaining?: number; reset?: number } }
    }
    const core = body.resources?.core
    if (typeof core?.limit !== 'number' || typeof core.remaining !== 'number') return null
    return {
      limit: core.limit,
      remaining: core.remaining,
      reset: typeof core.reset === 'number' ? new Date(core.reset * 1000) : null,
    }
  } catch {
    return null
  }
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
  status: RateLimitStatus | null
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
      headers: headersFor(options),
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
  count.status = statusFrom(response) ?? count.status

  if (isRateLimited(response)) {
    throw new RequestFailure({
      kind: 'rate-limited',
      reset: parseReset(response.headers.get('x-ratelimit-reset')),
    })
  }
  // A token GitHub refuses is the viewer's to fix, and saying so is the only way they can. It has
  // to be separated from the generic failure below, which tells them nothing actionable.
  if (response.status === 401) throw new RequestFailure({ kind: 'bad-credentials' })
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
 * A closed issue reaches the graph only as somebody's blocker, inside a dependency payload — and
 * only when the viewer is asked to show closed issues.
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
 * The issues worth one dependency request each.
 *
 * `blocked_by` counts blockers that are still open, `total_blocked_by` counts open and closed. With
 * closed issues hidden only the open ones can produce an edge, so asking on the total would spend
 * budget fetching blockers that are then thrown away — 10 requests instead of 3 on
 * martonpaulo/tabelo. Showing closed issues is exactly what buys that difference back.
 */
export function issuesNeedingBlockers(
  issues: IssuePayload[],
  includeClosed = false,
): IssuePayload[] {
  const key = includeClosed ? 'total_blocked_by' : 'blocked_by'
  return issues.filter((issue) => (issue.issue_dependencies_summary?.[key] ?? 0) > 0)
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
  const count: RequestCounter = { requests: 0, status: null }

  let issues: IssuePayload[]
  try {
    issues = await listIssues(target, options, count)
  } catch (error) {
    if (error instanceof RequestFailure) return { ok: false, failure: error.failure }
    throw error
  }

  const needBlockers = issuesNeedingBlockers(issues, options.includeClosed)

  if (needBlockers.length > 0 && options.confirmDependencies) {
    const approved = await options.confirmDependencies(needBlockers.length)
    if (!approved) return { ok: false, failure: { kind: 'cancelled' } }
  }

  const blockers = new Map<number, IssuePayload[]>()
  const unresolved: UnresolvedDependency[] = []
  let rateLimited = false
  let rateLimitReset: Date | null = null

  options.onProgress?.({ done: 0, total: needBlockers.length })

  // Kept per issue rather than appended on completion, so the report stays in issue order however
  // the parallel requests happen to finish.
  const failures: (UnresolvedDependency | null)[] = needBlockers.map(() => null)
  let done = 0
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (nextIndex < needBlockers.length) {
      const index = nextIndex
      nextIndex += 1
      const issue = needBlockers[index]

      // Once the budget is gone every further request fails the same way; stop asking and report.
      if (rateLimited) {
        failures[index] = {
          number: issue.number,
          reason: 'rate limit reached before it was read',
        }
      } else {
        const url =
          `${API_ROOT}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}` +
          `/issues/${issue.number}/dependencies/blocked_by`

        try {
          const list = (await (await request(url, options, count)).json()) as IssuePayload[]
          // Whatever GitHub returns is what the graph draws. A summary count that disagrees with the
          // list is GitHub's own inconsistency — a blocker in a repository this reader cannot see,
          // for one — and reporting it as a gap only tells the reader something they can do nothing
          // with.
          blockers.set(issue.number, list)
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error
          if (!(error instanceof RequestFailure)) throw error

          if (error.failure.kind === 'rate-limited') {
            rateLimited = true
            rateLimitReset = error.failure.reset
            failures[index] = { number: issue.number, reason: 'rate limit reached' }
          } else if (error.failure.kind === 'network') {
            failures[index] = { number: issue.number, reason: error.failure.message }
          } else if (error.failure.kind === 'bad-credentials') {
            failures[index] = { number: issue.number, reason: 'the token was rejected' }
          } else if (error.failure.kind === 'not-found') {
            failures[index] = { number: issue.number, reason: 'dependencies were not found' }
          } else if (error.failure.kind === 'unexpected') {
            failures[index] = { number: issue.number, reason: error.failure.message }
          }
        }
      }

      done += 1
      options.onProgress?.({ done, total: needBlockers.length })
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DEPENDENCY_CONCURRENCY, needBlockers.length) }, worker),
  )

  for (const failure of failures) {
    if (failure) unresolved.push(failure)
  }

  return {
    ok: true,
    data: {
      issues,
      blockers,
      complete: unresolved.length === 0,
      unresolved,
      rateLimited,
      rateLimitReset,
      requestCount: count.requests,
      rateLimit: count.status,
      includedClosed: options.includeClosed === true,
    },
  }
}

/**
 * Repository name suggestions for the index form.
 *
 * Search has its own budget — 10 requests per minute unauthenticated — separate from the core one
 * the graph spends, so typing never eats into what drawing a graph costs, and a throttled or failed
 * search simply returns nothing rather than surfacing an error.
 * https://docs.github.com/en/rest/search/search#rate-limit
 */
export async function searchRepositories(
  input: string,
  options: LoadOptions = {},
): Promise<string[]> {
  const trimmed = input.trim()
  if (trimmed.length < 2) return []

  const [ownerPart, repoPart] = trimmed.includes('/') ? trimmed.split('/') : [null, trimmed]
  const query = ownerPart
    ? `${repoPart ? `${repoPart} in:name ` : ''}user:${ownerPart}`
    : `${repoPart} in:name`

  const url =
    `${API_ROOT}/search/repositories?per_page=7&q=${encodeURIComponent(query)}` +
    (repoPart ? '' : '&sort=updated')

  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      signal: options.signal,
      headers: headersFor(options),
    })
    if (!response.ok) return []
    const body = (await response.json()) as { items?: { full_name?: string }[] }
    return (body.items ?? [])
      .map((item) => item.full_name)
      .filter((name): name is string => typeof name === 'string')
  } catch {
    return []
  }
}
