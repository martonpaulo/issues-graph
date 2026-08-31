import { canonicalSlug } from './route'
import {
  asStringArray,
  clearStored,
  hasStored,
  readStored,
  storedKeys,
  writeStored,
  type StorageWriteResult,
} from './storage'

/**
 * Which repositories this browser keeps data for, and for how long.
 *
 * Everything the viewer saves is keyed by one repository: the graph it read, and the cards the
 * reader dimmed on it. Left alone that grows one key per repository slug anybody ever opened,
 * forever, until the quota rejects the next write — and the write that gets rejected is the one
 * for the repository being read right now, which is the only one that cost anything.
 *
 * So there is one list, in most-recently-used order, and it is the single owner of the question
 * "does this browser hold anything for this repository". Two budgets bound it: a count, because
 * the list also feeds the recent-repository suggestions and a longer list of names helps nobody,
 * and a size, because six large backlogs can exhaust the quota on their own. Falling off the end
 * removes every key that repository owns and nothing else. That is safe precisely because none of
 * it is canonical: a graph is reconstructible from GitHub, and dimming is a view preference on a
 * repository the reader has stopped visiting.
 *
 * Recency is the only ordering, and both a read and a write count as a use.
 */

const INDEX_KEY = 'issue-graph:retention'

/**
 * The list of names written before this index existed. It is read once, when no index is present,
 * so a reader's recent repositories survive the change; it is never written again. The key itself
 * is left in place rather than removed, because a build without this module still reads it.
 */
const LEGACY_RECENT_KEY = 'issue-graph:recent'

const CACHE_PREFIX = 'issue-graph:cache:'
// The stored key still says "hidden": it predates the rename to dimming, and the copy change is
// not worth stranding every reader's saved set. The value is a list of node IDs either way.
const DIMMED_PREFIX = 'issue-graph:hidden:'

/** Every key one repository owns. Eviction and clearing both remove exactly this set. */
export const cacheKey = (identity: string) => `${CACHE_PREFIX}${identity}`
export const dimmedKey = (identity: string) => `${DIMMED_PREFIX}${identity}`

/**
 * As many repositories as the input field can usefully offer back. The suggestion list was the
 * first thing to need a limit and it is still the tightest one, so it sets the count.
 */
export const MAX_ENTRIES = 6

/**
 * The size budget, in the UTF-16 code units `JSON.stringify` produces and browsers measure
 * localStorage in. Browsers grant an origin roughly 5 MB; a fifth of that leaves the token, the
 * preferences and this index room they will never come close to needing, and still holds several
 * backlogs of the size this viewer is meant for.
 * https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API#storage_quotas_and_eviction_criteria
 */
export const MAX_CHARS = 1_000_000

export interface RetentionEntry {
  /** The spelling to show the reader, which is the one they last opened the repository with. */
  slug: string
  /** When the repository was last read or written, as a millisecond timestamp. */
  usedAt: number
  /** How much the saved graph occupies, or 0 when none is held. */
  chars: number
  /**
   * Whether the reader opened this repository themselves.
   *
   * Not every repository the browser holds data for is one to offer back. Dimming cards on a
   * shared link writes a key under that repository without the reader ever having chosen it, and
   * a copy that arrived in somebody else's link must not be offered as this viewer's own. Such a
   * repository still has to be counted and still has to be clearable, so it belongs in this list
   * — just not in the suggestions.
   */
  opened: boolean
}

interface RetentionIndex {
  version: 1
  entries: RetentionEntry[]
}

function isEntry(value: unknown): value is RetentionEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.slug === 'string' &&
    typeof entry.usedAt === 'number' &&
    Number.isFinite(entry.usedAt) &&
    typeof entry.chars === 'number' &&
    Number.isFinite(entry.chars) &&
    entry.chars >= 0 &&
    typeof entry.opened === 'boolean'
  )
}

function decodeIndex(value: unknown): RetentionIndex | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const index = value as Record<string, unknown>
  if (index.version !== 1) return undefined
  if (!Array.isArray(index.entries) || !index.entries.every(isEntry)) return undefined
  return { version: 1, entries: index.entries }
}

/**
 * What a browser with no index holds, as entries.
 *
 * Two sources, and the second is the one that matters. The recent names an earlier build wrote
 * are the repositories the reader chose, in the order it wrote them. But that list was capped at
 * six while the keys behind it never were, so every repository that fell off it years ago still
 * has a saved graph and a dimmed set sitting in storage. Seeding the index from the names alone
 * would leave exactly those keys permanently unindexed, uncounted and beyond eviction — the
 * original unbounded growth, preserved for every existing reader, in the change meant to end it.
 *
 * So the keys themselves are read too. Whatever is discovered that the names do not cover follows
 * them, ordered after every repository the reader actually chose, which is where the budgets will
 * cut. A discovered repository is not marked as opened: its name already fell out of the
 * suggestions, and putting it back is not this migration's business — bounding it is.
 *
 * Sizes come from the stored values, so the first enforcement measures what is really there
 * rather than trusting a record earlier builds never kept.
 */
function unindexedEntries(): RetentionEntry[] {
  const chosen = readStored(LEGACY_RECENT_KEY, asStringArray, []).slice(0, MAX_ENTRIES)
  const entries: RetentionEntry[] = chosen.map((slug) => ({
    slug,
    usedAt: 0,
    chars: heldChars(canonicalSlug(slug)),
    opened: true,
  }))

  const seen = new Set(entries.map((entry) => canonicalSlug(entry.slug)))
  for (const identity of ownedIdentities()) {
    if (seen.has(identity)) continue
    seen.add(identity)
    entries.push({ slug: identity, usedAt: 0, chars: heldChars(identity), opened: false })
  }

  return entries
}

/** Every repository this browser holds a key for, discovered from storage rather than a list. */
function ownedIdentities(): string[] {
  const identities = new Set<string>()
  for (const key of storedKeys()) {
    if (key.startsWith(CACHE_PREFIX)) identities.add(key.slice(CACHE_PREFIX.length))
    else if (key.startsWith(DIMMED_PREFIX)) identities.add(key.slice(DIMMED_PREFIX.length))
  }
  return [...identities]
}

/** How much the saved graph under this identity actually occupies right now. */
function heldChars(identity: string): number {
  return readStored(cacheKey(identity), (value) => JSON.stringify(value).length, 0)
}

/** The retained repositories, most recently used first. */
export function retained(): RetentionEntry[] {
  const index = readStored<RetentionIndex | null>(INDEX_KEY, decodeIndex, null)
  return index === null ? unindexedEntries() : index.entries
}

/** The repositories to offer back: the ones the reader chose, in most-recently-used order. */
export function openedSlugs(): string[] {
  return retained()
    .filter((entry) => entry.opened)
    .map((entry) => entry.slug)
}

/**
 * Whether this browser holds anything at all for the repository, so the page can offer to clear
 * it. The index is the fast answer; the keys are checked too, because a value the index has not
 * caught up with is still the reader's data and still theirs to remove.
 */
export function holdsData(slug: string): boolean {
  const identity = canonicalSlug(slug)
  if (retained().some((entry) => canonicalSlug(entry.slug) === identity)) return true
  return storedKeys().some((key) => key === cacheKey(identity) || key === dimmedKey(identity))
}

function save(entries: RetentionEntry[]): StorageWriteResult {
  return writeStored(INDEX_KEY, { version: 1, entries } satisfies RetentionIndex)
}

/** Removes every key the repository owns, and nothing else. */
function dropKeys(slug: string): StorageWriteResult {
  const identity = canonicalSlug(slug)
  const graph = clearStored(cacheKey(identity))
  const dimmed = clearStored(dimmedKey(identity))
  return graph.ok ? dimmed : graph
}

/**
 * The list trimmed to both budgets, with everything past the cut removed from storage.
 *
 * The most recent entry survives whatever it costs. It is the repository the reader is looking at,
 * and evicting it would mean a large backlog never gets saved at all — every visit paying GitHub
 * requests to produce a copy that is thrown away as it is written.
 */
function enforce(entries: RetentionEntry[]): RetentionEntry[] {
  let cut = entries.length
  let total = 0

  for (let index = 0; index < entries.length; index += 1) {
    total += entries[index].chars
    if (index > 0 && (index >= MAX_ENTRIES || total > MAX_CHARS)) {
      cut = index
      break
    }
  }

  for (const evicted of entries.slice(cut)) dropKeys(evicted.slug)
  return entries.slice(0, cut)
}

/**
 * Moves one repository to the front of the list, letting the caller say what else changed about
 * it, and applies both budgets to the result.
 */
function promote(
  slug: string,
  next: (existing: RetentionEntry | undefined) => RetentionEntry,
): StorageWriteResult {
  const identity = canonicalSlug(slug)
  const entries = retained()
  const existing = entries.find((entry) => canonicalSlug(entry.slug) === identity)
  const rest = entries.filter((entry) => canonicalSlug(entry.slug) !== identity)
  return save(enforce([next(existing), ...rest]))
}

/**
 * Records that the reader opened this repository, under the spelling they opened it with.
 *
 * One repository occupies one slot whatever its casing, and the newest spelling wins, so the list
 * keeps showing the reader the spelling they just used.
 */
export function rememberRepository(slug: string): void {
  promote(slug, (existing) => ({
    slug,
    usedAt: Date.now(),
    chars: existing?.chars ?? 0,
    opened: true,
  }))
}

/** Records that a saved graph of this size is now held for the repository. */
/**
 * Records that a saved graph of this size is now held for the repository, and reports whether the
 * index took it.
 *
 * The caller has to know. A saved graph the index never learned about is worse than no saved
 * graph: `retained()` reads the keys themselves only when there is no valid index at all, so a
 * key written alongside a refused index update is not merely unbudgeted, it is undiscoverable for
 * as long as the index stays readable — the unbounded growth this module exists to end, returning
 * through the one door it left open.
 */
export function recordCacheSize(identity: string, chars: number): StorageWriteResult {
  return promote(identity, (existing) => ({
    slug: existing?.slug ?? identity,
    usedAt: Date.now(),
    chars,
    opened: existing?.opened ?? true,
  }))
}

/**
 * Records a use that changed nothing else — reading the saved copy back. Recency is what the
 * budgets evict on, so a repository opened from its saved copy has to count as used or it ages
 * out while the reader is still visiting it.
 */
export function touchRepository(identity: string): void {
  promote(identity, (existing) => ({
    slug: existing?.slug ?? identity,
    usedAt: Date.now(),
    chars: existing?.chars ?? 0,
    opened: existing?.opened ?? true,
  }))
}

/**
 * Records that dimmed cards are now stored for a repository.
 *
 * Dimming is the one thing the viewer saves for a repository the reader never chose: a shared
 * link draws somebody else's copy, and dimming a card on it writes a key under that repository
 * while nothing else does. Unregistered, that key belonged to no budget and had no way to be
 * cleared. It is registered without being marked as opened, so it is counted and clearable
 * without the shared link turning into a suggestion.
 */
/**
 * Records that a repository no longer has dimmed cards.
 *
 * An empty set is not a preference, and a key holding one is not worth a retention slot. Without
 * this, dimming a card on a shared link and then restoring it left the repository in the list
 * forever: nothing to preserve, one of six slots occupied, able to evict a saved copy somebody
 * actually wanted, and still offering to clear data that no longer existed.
 *
 * The entry goes only when nothing else is held under it. A repository with a saved graph stays,
 * because the graph is what its slot is for.
 */
export function releaseDimmed(identity: string): void {
  const key = canonicalSlug(identity)
  clearStored(dimmedKey(key))
  if (hasStored(cacheKey(key))) return

  const entries = retained()
  const kept = entries.filter((entry) => canonicalSlug(entry.slug) !== key)
  if (kept.length !== entries.length) save(kept)
}

export function registerDimmed(identity: string): void {
  promote(identity, (existing) => ({
    slug: existing?.slug ?? identity,
    usedAt: Date.now(),
    chars: existing?.chars ?? 0,
    opened: existing?.opened ?? false,
  }))
}

/**
 * Gives up the least recently used repository other than `keep`, and reports whether there was
 * one to give up. Called when the quota rejected a write that the budgets alone thought was
 * affordable — the budgets cannot see the token, the preferences, or whatever else shares the
 * origin, so the browser's own refusal is the only accurate signal.
 */
export function evictLeastRecent(keep: string): boolean {
  const identity = canonicalSlug(keep)
  const entries = retained()

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (canonicalSlug(entries[index].slug) === identity) continue
    dropKeys(entries[index].slug)
    // Only a recorded eviction counts. The caller retries its own write while this keeps saying
    // yes, and an index that did not take the removal reads back unchanged: the same entry is
    // chosen again, its already-absent keys are removed again, and the loop never ends. Reporting
    // the failed write is what makes the retry terminate — on a page where the alternative is a
    // synchronous spin with the tab frozen.
    return save([...entries.slice(0, index), ...entries.slice(index + 1)]).ok
  }

  return false
}

/**
 * Removes everything this browser holds for one repository: its saved graph, its dimmed cards,
 * and its place in the list. Scoped on purpose — the reader asked about this repository, not
 * about the others, and not about the token, which is cleared where it is set.
 */
export function clearRepositoryData(slug: string): StorageWriteResult {
  const identity = canonicalSlug(slug)
  const result = dropKeys(slug)
  save(retained().filter((entry) => canonicalSlug(entry.slug) !== identity))
  return result
}
