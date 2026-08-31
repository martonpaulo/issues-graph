import { beforeEach, describe, expect, it } from 'vitest'

import { mergeSuggestions, rememberTarget, recentTargets } from './suggestions'

/**
 * The tests run under the `node` environment, so `window.localStorage` has to be supplied. The
 * store is a plain map: what matters here is what the module reads back out of it.
 */
function installStorage(): Map<string, string> {
  const entries = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => void entries.set(key, value),
        removeItem: (key: string) => void entries.delete(key),
      },
    },
  })
  return entries
}

let store: Map<string, string>

beforeEach(() => {
  store = installStorage()
})

function remember(...slugs: string[]): void {
  for (const slug of slugs) {
    const [owner, repo] = slug.split('/')
    rememberTarget({ owner, repo })
  }
}

describe('recentTargets', () => {
  it('lists the most recently opened repository first and never repeats one', () => {
    remember('a/one', 'b/two', 'a/one')
    expect(recentTargets()).toEqual(['a/one', 'b/two'])
  })

  it('keeps at most six entries', () => {
    remember('o/r1', 'o/r2', 'o/r3', 'o/r4', 'o/r5', 'o/r6', 'o/r7')
    expect(recentTargets()).toEqual(['o/r7', 'o/r6', 'o/r5', 'o/r4', 'o/r3', 'o/r2'])
  })

  it('keeps one entry per repository when the same one is opened in different casing', () => {
    remember('Acme/App', 'acme/app')
    expect(recentTargets()).toEqual(['acme/app'])
  })

  it('keeps repositories that differ by more than casing apart', () => {
    remember('acme/app', 'acme/apps')
    expect(recentTargets()).toEqual(['acme/apps', 'acme/app'])
  })

  it('holds six distinct repositories when spellings repeat', () => {
    remember('o/r1', 'O/R1', 'o/r2', 'o/r3', 'o/r4', 'o/r5', 'o/r6')
    expect(recentTargets()).toEqual(['o/r6', 'o/r5', 'o/r4', 'o/r3', 'o/r2', 'O/R1'])
  })

  it('collapses a stored list that already holds both spellings on the next write', () => {
    store.set('issue-graph:recent', JSON.stringify(['Acme/App', 'b/two', 'acme/app']))
    remember('c/three')

    expect(recentTargets()).toEqual(['c/three', 'Acme/App', 'b/two'])
  })

  it('drops stored entries that are no longer a valid owner/repo slug', () => {
    store.set('issue-graph:recent', JSON.stringify(['a/one', 'not a slug']))
    expect(recentTargets()).toEqual(['a/one'])
  })

  /* The list is written by this build but read by every later one, and it is editable by hand.
     A value that is not a list of strings has to be ignored here, because the caller maps over
     what comes back. */

  it('offers nothing when the stored list is not an array', () => {
    store.set('issue-graph:recent', JSON.stringify({ 0: 'a/one' }))
    expect(recentTargets()).toEqual([])
  })

  it('offers nothing when the stored array holds something other than strings', () => {
    store.set('issue-graph:recent', JSON.stringify(['a/one', { owner: 'b', repo: 'two' }]))
    expect(recentTargets()).toEqual([])
  })

  it('offers nothing rather than throwing on stored text that is not JSON', () => {
    store.set('issue-graph:recent', 'a/one')
    expect(recentTargets()).toEqual([])
  })

  it('replaces a list of the wrong shape on the next write instead of failing', () => {
    store.set('issue-graph:recent', JSON.stringify('a/one'))
    remember('b/two')

    expect(recentTargets()).toEqual(['b/two'])
  })
})

describe('mergeSuggestions', () => {
  it('offers every recent repository when nothing is typed', () => {
    remember('a/one', 'b/two')
    expect(mergeSuggestions('', [])).toEqual(['b/two', 'a/one'])
  })

  it('filters recents by the typed text, case-insensitively', () => {
    remember('a/One', 'b/two')
    expect(mergeSuggestions('ON', [])).toEqual(['a/One'])
  })

  it('appends search results after the recents, without repeating one', () => {
    remember('a/one')
    expect(mergeSuggestions('one', ['a/one', 'c/one'])).toEqual(['a/one', 'c/one'])
  })

  it('does not offer a search result a recent already names in a different casing', () => {
    remember('Acme/App')
    expect(mergeSuggestions('app', ['acme/app', 'other/app'])).toEqual(['Acme/App', 'other/app'])
  })

  it('caps the list at eight options', () => {
    const found = Array.from({ length: 12 }, (_, index) => `owner/repo${index}`)
    expect(mergeSuggestions('repo', found)).toHaveLength(8)
  })
})
