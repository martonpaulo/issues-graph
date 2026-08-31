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

/**
 * `decodeURIComponent` throws `URIError` on a lone `%` or an escape that is not valid UTF-8, and a
 * hand-edited or truncated shared link produces exactly that. Returning `null` keeps the failure
 * inside the route model instead of letting it escape into a render.
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/**
 * Splits a pathname into segments, dropping the Vite base prefix and empty parts. Returns `null`
 * when any segment carries a malformed percent escape, which no path this app builds ever does.
 */
export function segmentsOf(pathname: string, base: string): string[] | null {
  const normalisedBase = base.endsWith('/') ? base : `${base}/`
  const withoutBase = pathname.startsWith(normalisedBase)
    ? pathname.slice(normalisedBase.length)
    : pathname.replace(/^\//, '')

  const segments: string[] = []
  for (const segment of withoutBase.split('/')) {
    if (segment.length === 0) continue
    const decoded = decodeSegment(segment)
    if (decoded === null) return null
    segments.push(decoded)
  }
  return segments
}

export function parseRoute(pathname: string, base: string): Route {
  const segments = segmentsOf(pathname, base)
  if (segments === null) {
    return { kind: 'invalid', reason: 'This URL is malformed. Enter a repository as owner/repo.' }
  }

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

/**
 * The one spelling an identity is keyed by.
 *
 * GitHub's `owner` and `repo` path parameters are not case-sensitive, so `Acme/App` and `acme/app`
 * address the same repository and its payloads answer in one canonical casing that the route need
 * not match. Two repositories differing only in case cannot both exist, so folding case merges
 * spellings of one repository and never two different ones. Names are ASCII — `parseRoute` rejects
 * anything else — so `toLowerCase` has no locale-dependent behavior here.
 *
 * https://docs.github.com/en/rest/issues/issue-dependencies
 */
export function canonicalSlug(slug: string): string {
  return slug.toLowerCase()
}

/** The canonical identity of a route target: a storage key, never a label. */
export function canonicalSlugOf(target: RepoTarget): string {
  return canonicalSlug(slugOf(target))
}

/** The product's name for what the page shows, and the title of the index route. */
export const TITLE = 'Issue dependencies'

/**
 * The document title for a route. Repository identity leads, because that is the half that
 * distinguishes one open tab from another.
 *
 * An invalid route reuses the index title rather than echoing the rejected path: `Start` already
 * shows the reason in the page, and repeating hand-edited input in the tab switcher and browser
 * history buys nothing. The value is assigned to `document.title`, which is character data and
 * never parsed as markup, so no name here reaches an HTML sink.
 */
export function titleForRoute(route: Route): string {
  return route.kind === 'graph' ? `${slugOf(route.target)} · ${TITLE}` : TITLE
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
