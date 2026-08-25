/**
 * Repository selection lives entirely in the URL: the viewer never ships per-repository code.
 *
 *   /dependencies/:owner/:repo
 *
 * The owner is always written out. A one-segment shorthand that defaulted to a particular owner
 * made a shared link mean different things depending on who deployed the site, and hid the fact
 * that the viewer reads any public repository, not one account's.
 */

export interface RepoTarget {
  owner: string
  repo: string
}

export type Route =
  | { kind: 'index' }
  | { kind: 'graph'; target: RepoTarget }
  | { kind: 'invalid'; reason: string }

/**
 * GitHub owner and repository names are ASCII, start alphanumeric, and allow `-`, `_` and `.`
 * afterwards. Validating before building a request URL keeps a hand-edited path from reaching
 * api.github.com as something other than a repository lookup.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

function isName(value: string): boolean {
  return NAME.test(value) && value !== '.' && value !== '..'
}

/** Splits a pathname into segments, dropping the Vite base prefix and empty parts. */
export function segmentsOf(pathname: string, base: string): string[] {
  const normalisedBase = base.endsWith('/') ? base : `${base}/`
  const withoutBase = pathname.startsWith(normalisedBase)
    ? pathname.slice(normalisedBase.length)
    : pathname.replace(/^\//, '')
  return withoutBase.split('/').filter((segment) => segment.length > 0).map(decodeURIComponent)
}

export function parseRoute(pathname: string, base: string): Route {
  const segments = segmentsOf(pathname, base)

  if (segments.length === 0) return { kind: 'index' }
  if (segments[0] !== 'dependencies') {
    return { kind: 'invalid', reason: `Unknown path "/${segments.join('/')}".` }
  }

  const rest = segments.slice(1)
  if (rest.length === 0) return { kind: 'index' }
  if (rest.length !== 2) {
    return { kind: 'invalid', reason: 'A dependency URL names an owner and a repository.' }
  }

  const [owner, repo] = rest
  if (!isName(owner)) return { kind: 'invalid', reason: `"${owner}" is not a valid owner name.` }
  if (!isName(repo)) return { kind: 'invalid', reason: `"${repo}" is not a valid repository name.` }

  return { kind: 'graph', target: { owner, repo } }
}

/** Builds the canonical path for a target. */
export function pathForTarget(target: RepoTarget, base: string): string {
  const normalisedBase = base.endsWith('/') ? base : `${base}/`
  return `${normalisedBase}dependencies/${target.owner}/${target.repo}`
}

export function slugOf(target: RepoTarget): string {
  return `${target.owner}/${target.repo}`
}

/** Accepts `owner/repo`, or the same thing pasted as a github.com URL. */
export function parseTargetInput(input: string): RepoTarget | null {
  const trimmed = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '')
  if (trimmed.length === 0) return null

  const parts = trimmed.split('/')
  if (parts.length !== 2) return null

  const [owner, repo] = parts
  if (!isName(owner) || !isName(repo)) return null

  return { owner, repo }
}
