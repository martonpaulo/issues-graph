import { beforeEach, describe, expect, it } from 'vitest'

import {
  cacheKey,
  clearRepositoryData,
  dimmedKey,
  evictLeastRecent,
  MAX_CHARS,
  MAX_ENTRIES,
  recordCacheSize,
  rememberRepository,
  retained,
  touchRepository,
} from './retention'

/**
 * The tests run under the `node` environment, so `window.localStorage` has to be supplied. The
 * store is a plain map: the point here is which keys the index adds and removes, not the
 * browser's own quota, which the module never sees anyway.
 */
function installStorage(overrides: Partial<Storage> = {}): Map<string, string> {
  const entries = new Map<string, string>()
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
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

/** Puts a repository in the index with both of the keys it owns already written. */
function hold(slug: string, chars = 10): void {
  store.set(cacheKey(slug.toLowerCase()), 'x'.repeat(chars))
  store.set(dimmedKey(slug.toLowerCase()), '["issue-1"]')
  recordCacheSize(slug, chars)
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
