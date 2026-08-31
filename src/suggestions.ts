import { canonicalSlug, parseTargetInput, slugOf, type RepoTarget } from './route'
import { asStringArray, readStored, writeStored } from './storage'

const RECENT_KEY = 'issue-graph:recent'
const RECENT_LIMIT = 6
/** As many options as fit under the field without the list becoming a page of its own. */
const SUGGESTION_LIMIT = 8

/**
 * One repository occupies one slot, whatever casing it was opened with. The earliest spelling in
 * the list wins, so a caller that puts the most recent one first keeps showing the reader the
 * spelling they just used.
 */
function dedupeByCanonical(slugs: string[]): string[] {
  const seen = new Set<string>()
  return slugs.filter((slug) => {
    const key = canonicalSlug(slug)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function recentTargets(): string[] {
  return readStored(RECENT_KEY, asStringArray, []).filter(
    (slug) => parseTargetInput(slug) !== null,
  )
}

export function rememberTarget(target: RepoTarget): void {
  const slug = slugOf(target)
  // Deduplicating the whole list, not just the entry being added, collapses a list written before
  // identity was canonical without the reader having to clear storage.
  const next = dedupeByCanonical([slug, ...recentTargets()]).slice(0, RECENT_LIMIT)
  writeStored(RECENT_KEY, next)
}

/**
 * Repositories opened before, matched against what is typed, followed by whatever live search
 * found for that same text. Recents come first because they cost nothing to offer and are the
 * likelier target; a repository already listed is never repeated, whichever casing the search
 * result spells it in.
 */
export function mergeSuggestions(typed: string, found: string[]): string[] {
  const needle = typed.toLowerCase()
  const recents = recentTargets().filter(
    (slug) => needle.length === 0 || slug.toLowerCase().includes(needle),
  )
  return dedupeByCanonical([...recents, ...found]).slice(0, SUGGESTION_LIMIT)
}
