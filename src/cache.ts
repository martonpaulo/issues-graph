import type { IssuePayload, RepositoryGraphData } from './github'
import {
  cacheKey,
  evictLeastRecent,
  recordCacheSize,
  retained,
  touchRepository,
} from './retention'
import { clearStored, readStored, writeStoredText, type StorageWriteResult } from './storage'

/**
 * A saved copy of one repository's graph data.
 *
 * The budget is 60 requests an hour, so re-reading a repository just to look at it again is the
 * most expensive thing this viewer can do. Keeping the last read means the second visit costs
 * nothing, and re-reading stays an explicit choice rather than a side effect of opening a link.
 *
 * Only the fields the graph consumes are stored: full GitHub issue payloads run to hundreds of
 * kilobytes and would hit the storage quota within a few repositories.
 */

/**
 * Every field is optional exactly where `IssuePayload` makes it optional, so a copy written before
 * assignees and sub-issues were read still parses. `version` therefore stays at 1: the shape is a
 * superset, and an older copy simply derives the states it used to derive.
 */
export interface StoredIssue {
  number: number
  title: string
  state: string
  state_reason: string | null
  html_url: string
  repository_url: string
  labels: { name: string; color: string }[]
  issue_dependencies_summary?: IssuePayload['issue_dependencies_summary']
  assignees?: IssuePayload['assignees']
  sub_issues_summary?: IssuePayload['sub_issues_summary']
  parent_issue_url?: IssuePayload['parent_issue_url']
}

export interface StoredGraph {
  version: 1
  savedAt: number
  issues: StoredIssue[]
  blockers: [number, StoredIssue[]][]
  complete: boolean
  unresolved: RepositoryGraphData['unresolved']
  includedClosed: boolean
  requestCount: number
}

export interface CachedGraph {
  savedAt: Date
  data: RepositoryGraphData
}

function project(issue: IssuePayload): StoredIssue {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    state_reason: issue.state_reason,
    html_url: issue.html_url,
    repository_url: issue.repository_url,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    issue_dependencies_summary: issue.issue_dependencies_summary,
    // Only the login: the rest of GitHub's user object is several hundred bytes per issue that
    // nothing reads, and this projection exists to stay inside a storage quota and a URL length.
    assignees: issue.assignees?.map((assignee) => ({ login: assignee.login })),
    sub_issues_summary: issue.sub_issues_summary,
    parent_issue_url: issue.parent_issue_url,
  }
}

/**
 * The reduced shape and its inverse are exported because a shared snapshot travels under the same
 * constraint this cache was written for: only the fields the graph consumes are small enough to
 * carry. One projection keeps the two from drifting apart.
 */
export function toStored(data: RepositoryGraphData, savedAt: number): StoredGraph {
  return {
    version: 1,
    savedAt,
    issues: data.issues.map(project),
    blockers: [...data.blockers].map(([number, list]) => [number, list.map(project)]),
    complete: data.complete,
    unresolved: data.unresolved,
    includedClosed: data.includedClosed,
    requestCount: data.requestCount,
  }
}

export function fromStored(stored: StoredGraph): RepositoryGraphData {
  return {
    issues: stored.issues,
    blockers: new Map(stored.blockers),
    complete: stored.complete,
    unresolved: stored.unresolved,
    includedClosed: stored.includedClosed,
    requestCount: stored.requestCount,
    // A copy spent its requests when it was read, not now, and the budget it saw then says
    // nothing about the budget today.
    rateLimited: false,
    rateLimitReset: null,
    rateLimit: null,
  }
}


/* Validating a stored graph ----------------------------------------------
   Local storage is hand-editable and outlives the build that wrote it, so a saved copy is
   untrusted input in the same way a shared link is. Checking only `version` leaves the rest to
   fail later and worse: an `issues` that is not an array reaches the layout and throws on
   `.map`, and a `savedAt` outside the ECMAScript time range becomes an Invalid Date that the
   banner renders as `NaN days ago`.

   This lives here because `cache.ts` owns the shape: it declares `StoredGraph`, writes it in
   `toStored`, and reads it back in `fromStored`. `snapshot.ts` carries the same payload through a
   URL fragment and validates it with this same function, so the schema has one definition rather
   than two free to drift apart. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isLabel(value: unknown): boolean {
  return isRecord(value) && typeof value.name === 'string' && typeof value.color === 'string'
}

/** A count GitHub reports: a whole number of blockers, never negative and never fractional. */
function isCount(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0
}

/**
 * The complete dependency summary, or nothing.
 *
 * Accepting any record here would be worse than accepting none: `graph.ts` derives the visible
 * blocked-or-ready state from `blocked_by`, and the quote derives its cost from
 * `total_blocked_by`, both through `?? 0`. That default catches an absent summary, which GitHub
 * legitimately omits, but not a present one whose count is `[]` or `"5"` — the first is drawn as
 * ready and the second compares as blocked, and neither falls back to a live read. So a summary
 * that is present is checked in full, and `undefined` remains the only way to say there is none.
 */
function isDependencySummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    isCount(value.blocked_by) &&
    isCount(value.total_blocked_by) &&
    isCount(value.blocking) &&
    isCount(value.total_blocking)
  )
}

/** Every field `buildGraph` and the cards read off an issue, and nothing more. */
function isIssue(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!Number.isInteger(value.number)) return false
  if (typeof value.title !== 'string') return false
  if (typeof value.state !== 'string') return false
  if (value.state_reason !== null && typeof value.state_reason !== 'string') return false
  if (typeof value.html_url !== 'string') return false
  if (typeof value.repository_url !== 'string') return false
  if (!Array.isArray(value.labels) || !value.labels.every(isLabel)) return false

  const summary = value.issue_dependencies_summary
  if (summary !== undefined && !isDependencySummary(summary)) return false
  return true
}

function isBlockerEntry(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    Array.isArray(value[1]) &&
    value[1].every(isIssue)
  )
}

function isUnresolved(value: unknown): boolean {
  return isRecord(value) && Number.isInteger(value.number) && typeof value.reason === 'string'
}

/**
 * Whether a number is a timestamp `Date` can actually represent.
 *
 * Finiteness is not enough: the ECMAScript time range is ±8.64e15 ms, so `1e20` is a perfectly
 * finite number that yields an Invalid Date. Asking the constructed date settles the whole
 * question at once — out of range, `NaN` and `Infinity` all fail the same way.
 * https://tc39.es/ecma262/#sec-time-values-and-time-range
 */
function isTimestamp(value: unknown): boolean {
  return typeof value === 'number' && !Number.isNaN(new Date(value).getTime())
}

/** Whether the stored graph is whole enough to draw. */
export function isStoredGraph(value: unknown): value is StoredGraph {
  if (!isRecord(value)) return false
  if (value.version !== 1) return false
  if (!isTimestamp(value.savedAt)) return false
  if (!Array.isArray(value.issues) || !value.issues.every(isIssue)) return false
  if (!Array.isArray(value.blockers) || !value.blockers.every(isBlockerEntry)) return false
  if (typeof value.complete !== 'boolean') return false
  if (!Array.isArray(value.unresolved) || !value.unresolved.every(isUnresolved)) return false
  if (typeof value.includedClosed !== 'boolean') return false
  if (typeof value.requestCount !== 'number' || !Number.isFinite(value.requestCount)) return false
  return true
}

/**
 * The decoder `readStored` calls. A copy that fails any check — including one written by a
 * version this build does not know — is ignored, never rewritten or removed: the cache is
 * reconstructible from GitHub, and deleting a value this build merely fails to understand would
 * destroy one an older or newer build still reads.
 */
export function decodeStoredGraph(value: unknown): StoredGraph | undefined {
  return isStoredGraph(value) ? value : undefined
}

export function readCache(slug: string): CachedGraph | null {
  const stored = readStored(cacheKey(slug), decodeStoredGraph, null)
  if (stored === null) return null

  // Reading a copy is using the repository, and the budgets evict on recency: without this, a
  // repository the reader opens from its saved copy every day still ages out behind ones they
  // read from GitHub once.
  touchRepository(slug)
  return { savedAt: new Date(stored.savedAt), data: fromStored(stored) }
}

/**
 * Saves the copy, reports whether it was saved, and keeps the browser inside its budgets.
 *
 * A full quota is answered by giving up the least recently used repository and trying again,
 * rather than by giving up on the write. What is surrendered is reconstructible from GitHub and
 * belongs to a repository nobody has opened lately; what is being written is the one read the
 * reader just paid for. The loop ends when the write succeeds or when there is nothing left to
 * surrender, and the caller is told either way.
 */
export function writeCache(slug: string, data: RepositoryGraphData): StorageWriteResult {
  const payload = JSON.stringify(toStored(data, Date.now()))
  const key = cacheKey(slug)

  // One attempt per repository that could be surrendered, counted before any of them is. Each
  // recorded eviction strictly shortens the list, so this bound is never reached in practice; it
  // is here because the cost of being wrong about that is a frozen tab rather than a failed
  // write, and a loop whose termination depends on storage agreeing to record something should
  // not be the only thing standing between the reader and a hung page.
  let attemptsLeft = retained().length

  let result = writeStoredText(key, payload)
  while (!result.ok && result.reason === 'quota' && attemptsLeft > 0 && evictLeastRecent(slug)) {
    attemptsLeft -= 1
    result = writeStoredText(key, payload)
  }

  if (!result.ok) return result

  // The write is not finished until the index knows about it. A graph key the index never
  // recorded is invisible to every budget — `retained()` falls back to reading the keys only when
  // there is no valid index at all — so it would sit there unbounded and undiscoverable while
  // this reported success. Rather than leave that, the key is taken back out and the failure is
  // reported, which is what puts the sentence about it on screen. Losing a copy that can be read
  // again from GitHub is the cheaper half of that trade.
  const indexed = recordCacheSize(slug, payload.length)
  if (!indexed.ok) {
    clearStored(key)
    return indexed
  }

  return result
}
