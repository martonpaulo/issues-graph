import type { IssuePayload, RepositoryGraphData } from './github'
import { readStored, writeStored } from './storage'

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

const KEY_PREFIX = 'issue-graph:cache:'

export interface StoredIssue {
  number: number
  title: string
  state: string
  state_reason: string | null
  html_url: string
  repository_url: string
  labels: { name: string; color: string }[]
  issue_dependencies_summary?: IssuePayload['issue_dependencies_summary']
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
  if (summary !== undefined && !isRecord(summary)) return false
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
  const stored = readStored<StoredGraph | null>(`${KEY_PREFIX}${slug}`, null)
  if (!stored || stored.version !== 1) return null

  return { savedAt: new Date(stored.savedAt), data: fromStored(stored) }
}

export function writeCache(slug: string, data: RepositoryGraphData): void {
  writeStored(`${KEY_PREFIX}${slug}`, toStored(data, Date.now()))
}
