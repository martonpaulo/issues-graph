import { parseTargetInput, slugOf, type RepoTarget } from './route'
import { asStringArray, readStored, writeStored } from './storage'

const RECENT_KEY = 'issue-graph:recent'
const RECENT_LIMIT = 6
/** As many options as fit under the field without the list becoming a page of its own. */
const SUGGESTION_LIMIT = 8

export function recentTargets(): string[] {
  return readStored(RECENT_KEY, asStringArray, []).filter(
    (slug) => parseTargetInput(slug) !== null,
  )
}

export function rememberTarget(target: RepoTarget): void {
  const slug = slugOf(target)
  const next = [slug, ...recentTargets().filter((entry) => entry !== slug)].slice(0, RECENT_LIMIT)
  writeStored(RECENT_KEY, next)
}

/**
 * Repositories opened before, matched against what is typed, followed by whatever live search
 * found for that same text. Recents come first because they cost nothing to offer and are the
 * likelier target; a slug already listed is never repeated.
 */
export function mergeSuggestions(typed: string, found: string[]): string[] {
  const needle = typed.toLowerCase()
  const merged = recentTargets().filter(
    (slug) => needle.length === 0 || slug.toLowerCase().includes(needle),
  )
  const seen = new Set(merged)
  for (const slug of found)
    if (!seen.has(slug)) {
      seen.add(slug)
      merged.push(slug)
    }
  return merged.slice(0, SUGGESTION_LIMIT)
}
