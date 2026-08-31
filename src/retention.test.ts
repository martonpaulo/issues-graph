import { beforeEach, describe, expect, it } from 'vitest'

import { canonicalSlug } from './route'
import {
  cacheKey,
  clearRepositoryData,
  dimmedKey,
  evictLeastRecent,
  holdsData,
  MAX_CHARS,
  MAX_ENTRIES,
  openedSlugs,
  recordCacheSize,
  releaseDimmed,
  saveDimmed,
  rememberRepository,
  retained,
  touchRepository,
} from './retention'

/**
 * The tests run under the `node` environment, so `window.localStorage` has to be supplied. The
 * store is a plain map: the point here is which keys the index adds and removes, not the
 * browser's own quota, which the module never sees anyway.
 */
function installStorage(
  overrides: Partial<Storage> = {},
  existing?: Map<string, string>,
): Map<string, string> {
  const entries = existing ?? new Map<string, string>()
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    // Enumerable, like the real thing: the retention index discovers keys older builds left
    // behind, and a fake that cannot be walked would silently pass every test about that.
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size
    },
    ...overrides,
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  })
  return entries
}

let store: Map<string, string>

beforeEach(() => {
  store = installStorage()
})

/**
 * Puts a repository in the index with both of the keys it owns already written, in the order the
 * viewer itself writes them: the reader's spelling is remembered first, then the saved graph's
 * size is recorded under the canonical identity.
 */
function hold(slug: string, chars = 10): void {
  const identity = canonicalSlug(slug)
  rememberRepository(slug)
  store.set(cacheKey(identity), 'x'.repeat(chars))
  store.set(dimmedKey(identity), '["issue-1"]')
  recordCacheSize(identity, chars)
}

function slugs(): string[] {
  return retained().map((entry) => entry.slug)
}

describe('retained', () => {
  it('is empty in a browser that has never opened a repository', () => {
    expect(retained()).toEqual([])
  })

  it('lists the most recently used repository first', () => {
    rememberRepository('a/one')
    rememberRepository('b/two')
    rememberRepository('a/one')

    expect(slugs()).toEqual(['a/one', 'b/two'])
  })

  it('keeps one slot per repository whatever spelling it was opened with', () => {
    rememberRepository('Acme/App')
    rememberRepository('acme/app')

    expect(slugs()).toEqual(['acme/app'])
  })

  it('adopts the names an earlier build saved, so recent repositories survive the change', () => {
    store.set('issue-graph:recent', JSON.stringify(['a/one', 'b/two']))

    expect(slugs()).toEqual(['a/one', 'b/two'])
    // The older build kept no record of what it saved, so no entry claims a size until one is
    // actually written.
    expect(retained().every((entry) => entry.chars === 0)).toBe(true)
  })

  it('falls back to those names when the index itself is not readable', () => {
    store.set('issue-graph:recent', JSON.stringify(['a/one']))
    store.set('issue-graph:retention', JSON.stringify({ version: 2, entries: [] }))

    expect(slugs()).toEqual(['a/one'])
  })
})

/* Every reader arriving at this build already has keys in storage, and before it there was no
   record of most of them: the recent-name list held six while the keys behind it were kept
   forever. A migration that reads only that list leaves every repository that fell off it
   permanently unindexed — uncounted, un-evictable, and carrying the exact unbounded growth this
   index exists to end. */

describe('adopting a browser that predates the index', () => {
  it('discovers the repositories no list ever recorded', () => {
    store.set('issue-graph:recent', JSON.stringify(['a/one']))
    store.set(cacheKey('old/forgotten'), '"x"')
    store.set(dimmedKey('old/dimmed'), '["issue-1"]')

    expect(slugs()).toEqual(['a/one', 'old/forgotten', 'old/dimmed'])
  })

  it('orders the reader\u2019s own repositories ahead of what it found', () => {
    store.set('issue-graph:recent', JSON.stringify(['a/one', 'b/two']))
    store.set(cacheKey('old/forgotten'), '"x"')

    expect(retained().map((entry) => entry.opened)).toEqual([true, true, false])
  })

  it('does not put a repository the reader lost long ago back in the suggestions', () => {
    store.set('issue-graph:recent', JSON.stringify(['a/one']))
    store.set(cacheKey('old/forgotten'), '"x"')

    expect(openedSlugs()).toEqual(['a/one'])
  })

  it('counts one repository once when both of its keys are present', () => {
    store.set(cacheKey('old/both'), '"x"')
    store.set(dimmedKey('old/both'), '["issue-1"]')

    expect(slugs()).toEqual(['old/both'])
  })

  it('measures what the discovered copies actually occupy', () => {
    store.set(cacheKey('old/forgotten'), '"0123456789"')

    expect(retained()[0].chars).toBe('"0123456789"'.length)
  })

  it('evicts what it discovered on the first write, ending the unbounded growth', () => {
    store.set('issue-graph:recent', JSON.stringify(['a/one']))
    for (let index = 1; index <= MAX_ENTRIES + 2; index += 1) {
      store.set(cacheKey(`old/r${index}`), '"x"')
      store.set(dimmedKey(`old/r${index}`), '["issue-1"]')
    }

    rememberRepository('new/opened')

    expect(retained()).toHaveLength(MAX_ENTRIES)
    expect(store.has(cacheKey('old/r8'))).toBe(false)
    expect(store.has(dimmedKey('old/r8'))).toBe(false)
  })

  it('leaves keys that are not a repository\u2019s alone while doing it', () => {
    store.set('issue-graph:token', '"ghp_example"')
    store.set('issue-graph:show-closed', 'true')
    store.set(cacheKey('old/forgotten'), '"x"')

    rememberRepository('new/opened')

    expect(store.get('issue-graph:token')).toBe('"ghp_example"')
    expect(store.get('issue-graph:show-closed')).toBe('true')
  })
})

describe('saveDimmed', () => {
  /* Dimming is the one thing saved for a repository the reader never chose: a shared link draws
     somebody else's copy and saves nothing, but dimming a card on it writes a key. */

  it('counts a repository held only by its dimmed cards', () => {
    saveDimmed('shared/link', ['issue-1'])

    expect(slugs()).toEqual(['shared/link'])
    expect(holdsData('shared/link')).toBe(true)
  })

  it('keeps it out of the suggestions, because the reader never chose it', () => {
    saveDimmed('shared/link', ['issue-1'])

    expect(openedSlugs()).toEqual([])
  })

  it('does not demote a repository the reader did choose', () => {
    rememberRepository('a/one')
    saveDimmed('a/one', ['issue-1'])

    expect(openedSlugs()).toEqual(['a/one'])
  })

  it('brings it under the same budget as everything else', () => {
    for (let index = 1; index <= MAX_ENTRIES + 1; index += 1) {
      saveDimmed(`shared/r${index}`, ['issue-1'])
    }

    expect(retained()).toHaveLength(MAX_ENTRIES)
  })
})

describe('a refused index write destroys nothing', () => {
  /* Deciding what to evict and destroying it were one step, inside a `save(enforce(...))`
     expression, so the keys went before the write that was meant to authorise them. A refused
     write then left the repository's data gone while the stored index still listed it — and a
     valid index is exactly the case where the keys are never re-read, so nothing would ever
     correct it. */

  function refuseTheIndex(): void {
    installStorage(
      {
        setItem: (key: string, value: string) => {
          if (key === 'issue-graph:retention') {
            throw new DOMException('exceeded', 'QuotaExceededError')
          }
          store.set(key, value)
        },
      },
      store,
    )
  }

  it('leaves the repository it would have evicted holding its data', () => {
    for (let index = 1; index <= MAX_ENTRIES; index += 1) hold(`o/r${index}`)
    refuseTheIndex()

    rememberRepository('o/newcomer')

    // `o/r1` is the least recent, and would have been the victim.
    expect(store.get(cacheKey('o/r1'))).toBe('x'.repeat(10))
    expect(store.get(dimmedKey('o/r1'))).toBe('["issue-1"]')
  })

  it('does not leave the index claiming data it just deleted', () => {
    for (let index = 1; index <= MAX_ENTRIES; index += 1) hold(`o/r${index}`)
    refuseTheIndex()

    rememberRepository('o/newcomer')

    // Every repository the index still names has data genuinely present. Checked against the
    // store rather than through `holdsData`, which answers from the index first and so cannot
    // catch the index lying about itself.
    for (const entry of retained()) {
      const identity = canonicalSlug(entry.slug)
      const present = store.has(cacheKey(identity)) || store.has(dimmedKey(identity))
      expect(present, `${entry.slug} is named by the index but holds nothing`).toBe(true)
    }
  })

  it('costs nobody their saved graph when a shared link cannot be indexed', () => {
    for (let index = 1; index <= MAX_ENTRIES; index += 1) hold(`o/r${index}`)
    refuseTheIndex()

    saveDimmed('shared/link', ['issue-1'])

    expect(store.has(cacheKey('o/r1'))).toBe(true)
    expect(store.has(dimmedKey('shared/link'))).toBe(false)
  })

  it('gives up the eviction rather than performing it unrecorded', () => {
    hold('o/old')
    hold('o/new')
    refuseTheIndex()

    expect(evictLeastRecent('o/new')).toBe(false)
    expect(store.get(cacheKey('o/old'))).toBe('x'.repeat(10))
  })
})

describe('saveDimmed holds its two halves together', () => {
  /* Storing the cards and recording the repository were two independent writes, and either could
     succeed alone: a value written past a refused index update is a key no budget can see, and an
     index entry written past a refused value is a slot held for nothing. */

  it('leaves nothing behind when the repository cannot be indexed', () => {
    installStorage(
      {
        setItem: (key: string, value: string) => {
          if (key === 'issue-graph:retention') {
            throw new DOMException('exceeded', 'QuotaExceededError')
          }
          store.set(key, value)
        },
      },
      store,
    )

    expect(saveDimmed('shared/link', ['issue-1'])).toMatchObject({ ok: false, reason: 'quota' })
    expect(store.has(dimmedKey('shared/link'))).toBe(false)
    expect(holdsData('shared/link')).toBe(false)
  })

  it('registers nothing when the cards themselves cannot be stored', () => {
    installStorage(
      {
        setItem: (key: string) => {
          if (key === dimmedKey('shared/link')) {
            throw new DOMException('exceeded', 'QuotaExceededError')
          }
          throw new Error('the index must not be written when the value was not')
        },
      },
      store,
    )

    expect(saveDimmed('shared/link', ['issue-1'])).toMatchObject({ ok: false })
    expect(retained()).toEqual([])
  })

  it('puts back the cards that were already there', () => {
    saveDimmed('shared/link', ['issue-1'])
    installStorage(
      {
        setItem: (key: string, value: string) => {
          if (key === 'issue-graph:retention') {
            throw new DOMException('exceeded', 'QuotaExceededError')
          }
          store.set(key, value)
        },
      },
      store,
    )
    // A second repository, so the one being written is not already the index's own head.
    store.set('issue-graph:retention', JSON.stringify({ version: 1, entries: [] }))

    saveDimmed('shared/link', ['issue-1', 'issue-2'])

    expect(store.get(dimmedKey('shared/link'))).toBe(JSON.stringify(['issue-1']))
  })

  /* A repository the index already knows is the case where rolling back would do harm: a failed
     registration costs only a stale position in the recency order, while discarding the dimming
     the reader just did would repair something nothing depends on. */

  it('keeps new dimming on a repository the index already holds', () => {
    hold('o/one')
    installStorage(
      {
        setItem: (key: string, value: string) => {
          if (key === 'issue-graph:retention') {
            throw new DOMException('exceeded', 'QuotaExceededError')
          }
          store.set(key, value)
        },
      },
      store,
    )

    expect(saveDimmed('o/one', ['issue-7'])).toEqual({ ok: true })
    expect(store.get(dimmedKey('o/one'))).toBe(JSON.stringify(['issue-7']))
  })
})

describe('releaseDimmed', () => {
  /* Dimming a card on a shared link and then restoring it used to leave the repository in the
     list forever: nothing left to preserve, one of six slots held, able to evict a saved copy
     somebody wanted, and still offering to clear data that no longer existed. */

  it('gives the slot back when nothing else is held for the repository', () => {
    saveDimmed('shared/link', ['issue-1'])
    expect(slugs()).toEqual(['shared/link'])

    releaseDimmed('shared/link')

    expect(retained()).toEqual([])
    expect(holdsData('shared/link')).toBe(false)
  })

  it('removes the dimmed key rather than leaving an empty one', () => {
    saveDimmed('shared/link', ['issue-1'])

    releaseDimmed('shared/link')

    expect(store.has(dimmedKey('shared/link'))).toBe(false)
  })

  it('keeps a repository whose saved graph is what its slot is for', () => {
    hold('o/one')

    releaseDimmed('o/one')

    expect(slugs()).toEqual(['o/one'])
    expect(store.has(cacheKey('o/one'))).toBe(true)
    expect(store.has(dimmedKey('o/one'))).toBe(false)
  })

  it('leaves every other repository where it was', () => {
    hold('o/keeps')
    saveDimmed('shared/link', ['issue-1'])

    releaseDimmed('shared/link')

    expect(slugs()).toEqual(['o/keeps'])
  })

  it('works under any spelling of the repository', () => {
    saveDimmed('Shared/Link', ['issue-1'])

    releaseDimmed('SHARED/LINK')

    expect(retained()).toEqual([])
  })
})

describe('holdsData', () => {
  it('is false for a repository this browser has never held anything for', () => {
    expect(holdsData('never/opened')).toBe(false)
  })

  it('is true for a key the index has not caught up with, which is still the reader\u2019s', () => {
    store.set(dimmedKey('stray/repo'), '["issue-1"]')

    expect(holdsData('stray/repo')).toBe(true)
  })

  it('answers under any spelling of the repository', () => {
    hold('Acme/App')

    expect(holdsData('ACME/APP')).toBe(true)
  })

  it('is false again once the data is cleared', () => {
    hold('o/one')
    clearRepositoryData('o/one')

    expect(holdsData('o/one')).toBe(false)
  })
})

describe('the entry budget', () => {
  it('gives up the least recently used repository past the limit', () => {
    for (let index = 1; index <= MAX_ENTRIES + 1; index += 1) hold(`o/r${index}`)

    expect(slugs()).toEqual(['o/r7', 'o/r6', 'o/r5', 'o/r4', 'o/r3', 'o/r2'])
  })

  it('removes both keys the evicted repository owns', () => {
    for (let index = 1; index <= MAX_ENTRIES + 1; index += 1) hold(`o/r${index}`)

    expect(store.has(cacheKey('o/r1'))).toBe(false)
    expect(store.has(dimmedKey('o/r1'))).toBe(false)
  })

  it('leaves every other key in the browser alone', () => {
    store.set('issue-graph:token', '"ghp_example"')
    store.set('issue-graph:show-closed', 'true')
    store.set('unrelated', 'kept')

    for (let index = 1; index <= MAX_ENTRIES + 1; index += 1) hold(`o/r${index}`)

    expect(store.get('issue-graph:token')).toBe('"ghp_example"')
    expect(store.get('issue-graph:show-closed')).toBe('true')
    expect(store.get('unrelated')).toBe('kept')
    expect(store.has(cacheKey('o/r2'))).toBe(true)
  })
})

describe('the size budget', () => {
  it('gives up the least recently used repositories until the total fits', () => {
    hold('o/old', MAX_CHARS / 2)
    hold('o/older', MAX_CHARS / 2)
    hold('o/new', MAX_CHARS / 2 + 1)

    expect(slugs()).toEqual(['o/new'])
    expect(store.has(cacheKey('o/old'))).toBe(false)
    expect(store.has(cacheKey('o/older'))).toBe(false)
  })

  it('keeps the repository just saved even when it alone exceeds the budget', () => {
    hold('o/small')
    hold('o/huge', MAX_CHARS + 1)

    expect(slugs()).toEqual(['o/huge'])
    expect(store.has(cacheKey('o/huge'))).toBe(true)
  })

  it('counts the size of the copy that is actually held, not the number of visits', () => {
    hold('o/one', 10)
    recordCacheSize('o/one', 20)

    expect(retained()).toEqual([expect.objectContaining({ slug: 'o/one', chars: 20 })])
  })
})

describe('touchRepository', () => {
  it('moves a repository back to the front without touching its size or its spelling', () => {
    hold('Acme/App', 42)
    hold('o/other')

    touchRepository('acme/app')

    expect(retained()[0]).toEqual(expect.objectContaining({ slug: 'Acme/App', chars: 42 }))
  })
})

describe('evictLeastRecent', () => {
  it('gives up the oldest repository and reports that it did', () => {
    hold('o/old')
    hold('o/new')

    expect(evictLeastRecent('o/new')).toBe(true)
    expect(slugs()).toEqual(['o/new'])
    expect(store.has(cacheKey('o/old'))).toBe(false)
  })

  it('never gives up the repository being written, however old its entry is', () => {
    hold('o/writing')
    hold('o/newer')

    expect(evictLeastRecent('o/writing')).toBe(true)
    expect(slugs()).toEqual(['o/writing'])

    // Nothing else is left to surrender, and saying so is what stops a retry loop.
    expect(evictLeastRecent('o/writing')).toBe(false)
    expect(store.has(cacheKey('o/writing'))).toBe(true)
  })

  /* The caller retries its own write for as long as this says yes. An index that did not record
     the removal reads back unchanged, so the same victim is chosen again and again — a
     synchronous loop with the tab frozen, in the very path meant to recover from a full quota. */

  it('reports no eviction when the index would not record it', () => {
    hold('o/old')
    hold('o/new')

    installStorage(
      {
        setItem: () => {
          throw new DOMException('exceeded', 'QuotaExceededError')
        },
      },
      store,
    )

    expect(evictLeastRecent('o/new')).toBe(false)
  })

  it('matches the protected repository by identity rather than by spelling', () => {
    hold('Acme/App')
    hold('o/other')

    expect(evictLeastRecent('acme/app')).toBe(true)
    expect(slugs()).toEqual(['Acme/App'])
  })
})

describe('clearRepositoryData', () => {
  it('removes the saved graph, the dimmed cards and the place in the list', () => {
    hold('o/one')
    hold('o/two')

    expect(clearRepositoryData('o/one')).toEqual({ ok: true })
    expect(store.has(cacheKey('o/one'))).toBe(false)
    expect(store.has(dimmedKey('o/one'))).toBe(false)
    expect(slugs()).toEqual(['o/two'])
  })

  it('leaves every other repository exactly as it was', () => {
    hold('o/one')
    hold('o/two')

    clearRepositoryData('o/one')

    expect(store.get(cacheKey('o/two'))).toBe('x'.repeat(10))
    expect(store.get(dimmedKey('o/two'))).toBe('["issue-1"]')
  })

  it('clears the repository under any spelling of it', () => {
    hold('Acme/App')

    clearRepositoryData('ACME/APP')

    expect(store.has(cacheKey('acme/app'))).toBe(false)
    expect(retained()).toEqual([])
  })

  it('reports a browser that refuses the removal rather than claiming it happened', () => {
    store = installStorage({
      removeItem: () => {
        throw new Error('storage is blocked')
      },
    })
    hold('o/one')

    expect(clearRepositoryData('o/one')).toEqual({
      ok: false,
      reason: 'unavailable',
      message: 'This browser is not letting the page save anything.',
    })
  })
})
