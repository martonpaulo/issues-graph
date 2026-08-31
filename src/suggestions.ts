import { openedSlugs, rememberRepository } from './retention'
import { canonicalSlug, parseTargetInput, slugOf, type RepoTarget } from './route'

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

/**
 * The repositories to offer back, most recently used first.
 *
 * They are read from the retention index rather than from a list of their own. Two lists would
 * have to agree about which repositories this browser knows, and they did not: names survived the
 * six-slot list while the graphs behind them were kept forever. One list is the fix, and the
 * suggestions are a view of it — the repositories the reader chose, which is not every repository
 * the browser holds data for.
 *
 * Deduplicating here as well as in the index costs nothing and collapses a list written before
 * identity was canonical, without the reader having to clear anything.
 */
export function recentTargets(): string[] {
  return dedupeByCanonical(openedSlugs()).filter((slug) => parseTargetInput(slug) !== null)
}

export function rememberTarget(target: RepoTarget): void {
  rememberRepository(slugOf(target))
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
