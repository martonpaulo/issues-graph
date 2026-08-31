import { canonicalSlug } from './route'
import {
  asStringArray,
  clearStored,
  readStored,
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
    entry.chars >= 0
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
 * The recent names an earlier build wrote, in the order it wrote them, as entries that claim no
 * stored size. Claiming none is the honest reading: those builds kept no record of what they
 * saved, so the first write under this index is what establishes a real size.
 */
function legacyEntries(): RetentionEntry[] {
  return readStored(LEGACY_RECENT_KEY, asStringArray, [])
    .slice(0, MAX_ENTRIES)
    .map((slug) => ({ slug, usedAt: 0, chars: 0 }))
}

/** The retained repositories, most recently used first. */
export function retained(): RetentionEntry[] {
  const index = readStored<RetentionIndex | null>(INDEX_KEY, decodeIndex, null)
  return index === null ? legacyEntries() : index.entries
}

function save(entries: RetentionEntry[]): void {
  writeStored(INDEX_KEY, { version: 1, entries } satisfies RetentionIndex)
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
): void {
  const identity = canonicalSlug(slug)
  const entries = retained()
  const existing = entries.find((entry) => canonicalSlug(entry.slug) === identity)
  const rest = entries.filter((entry) => canonicalSlug(entry.slug) !== identity)
  save(enforce([next(existing), ...rest]))
}

/**
 * Records that the reader opened this repository, under the spelling they opened it with.
 *
 * One repository occupies one slot whatever its casing, and the newest spelling wins, so the list
 * keeps showing the reader the spelling they just used.
 */
export function rememberRepository(slug: string): void {
  promote(slug, (existing) => ({ slug, usedAt: Date.now(), chars: existing?.chars ?? 0 }))
}

/** Records that a saved graph of this size is now held for the repository. */
export function recordCacheSize(identity: string, chars: number): void {
  promote(identity, (existing) => ({
    slug: existing?.slug ?? identity,
    usedAt: Date.now(),
    chars,
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
    save([...entries.slice(0, index), ...entries.slice(index + 1)])
    return true
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
