import { beforeEach, describe, expect, it } from 'vitest'

import { readStored, writeStored } from './storage'

/**
 * The tests run under the `node` environment, so `window.localStorage` has to be supplied. The
 * store is a plain map: what matters here is what storage.ts round-trips through it and how it
 * behaves when access throws, not the browser's own quota or eviction rules.
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

/**
 * Server-side rendering and any non-browser consumer has no `window` at all. storage.ts catches
 * the resulting ReferenceError in the same guard it uses for a browser that refuses access, so
 * the behaviour is covered by the same contract and deserves the same test.
 */
function removeWindow(): void {
  Reflect.deleteProperty(globalThis, 'window')
}


let entries: Map<string, string>

beforeEach(() => {
  entries = installStorage()
})

describe('readStored', () => {
  it('returns the fallback for a key that was never written', () => {
    expect(readStored('graph:layout', 'vertical')).toBe('vertical')
  })

  it('reads back the value a write saved', () => {
    writeStored('graph:filters', { closed: true, labels: ['type: bug'] })

    expect(readStored('graph:filters', { closed: false, labels: [] as string[] })).toEqual({
      closed: true,
      labels: ['type: bug'],
    })
  })

  it('returns the fallback rather than throwing on text that is not JSON', () => {
    entries.set('graph:layout', 'vertical')

    expect(readStored('graph:layout', 'horizontal')).toBe('horizontal')
  })

  it('returns the fallback rather than throwing when storage is unreadable', () => {
    installStorage({
      getItem: () => {
        throw new Error('storage blocked')
      },
    })

    expect(readStored('graph:layout', 'vertical')).toBe('vertical')
  })

  // A stored `null` is a value that was written, not an absent key, so it wins over the fallback.
  it('keeps a stored null instead of substituting the fallback', () => {
    writeStored('graph:repo', null)

    expect(readStored<string | null>('graph:repo', 'martonpaulo/tabelo')).toBeNull()
  })

  it('returns the fallback when there is no window at all', () => {
    removeWindow()

    expect(readStored('graph:layout', 'vertical')).toBe('vertical')
  })
})

describe('writeStored', () => {
  it('stores the JSON form under the exact key', () => {
    writeStored('graph:filters', { closed: true })

    expect(entries.get('graph:filters')).toBe('{"closed":true}')
  })

  it('replaces the previous value of the same key', () => {
    writeStored('graph:layout', 'vertical')
    writeStored('graph:layout', 'horizontal')

    expect(entries.size).toBe(1)
    expect(readStored('graph:layout', 'vertical')).toBe('horizontal')
  })

  it('stays silent when storage refuses the write', () => {
    installStorage({
      setItem: () => {
        throw new Error('quota exceeded')
      },
    })

    expect(() => writeStored('graph:layout', 'vertical')).not.toThrow()
  })

  it('stays silent when there is no window at all', () => {
    removeWindow()
    expect(() => writeStored('issue-graph:theme', 'dark')).not.toThrow()
  })
})
