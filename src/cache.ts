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

export function readCache(slug: string): CachedGraph | null {
  const stored = readStored<StoredGraph | null>(`${KEY_PREFIX}${slug}`, null)
  if (!stored || stored.version !== 1) return null

  return { savedAt: new Date(stored.savedAt), data: fromStored(stored) }
}

export function writeCache(slug: string, data: RepositoryGraphData): void {
  writeStored(`${KEY_PREFIX}${slug}`, toStored(data, Date.now()))
}
