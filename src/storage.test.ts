import { afterEach, describe, expect, it } from 'vitest'

import { readStored, writeStored } from './storage'

/**
 * The tests run under the `node` environment, so `window.localStorage` has to be supplied. The
 * store is a plain map: what matters here is what storage.ts round-trips through it and how it
 * behaves when the browser refuses access, not the browser's own quota or eviction behavior.
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

function removeWindow(): void {
  Reflect.deleteProperty(globalThis, 'window')
}

afterEach(() => {
  removeWindow()
})

describe('readStored', () => {
  it('returns the fallback for a key that was never written', () => {
    installStorage()
    expect(readStored('issue-graph:missing', 'fallback')).toBe('fallback')
  })

  it('parses the stored JSON value', () => {
    const entries = installStorage()
    entries.set('issue-graph:theme', JSON.stringify({ mode: 'dark', density: 2 }))
    expect(readStored('issue-graph:theme', null)).toEqual({ mode: 'dark', density: 2 })
  })

  it('round-trips a value written by writeStored', () => {
    installStorage()
    writeStored('issue-graph:recent', ['martonpaulo/tabelo'])
    expect(readStored<string[]>('issue-graph:recent', [])).toEqual(['martonpaulo/tabelo'])
  })

  it('returns the fallback when the stored value is not valid JSON', () => {
    const entries = installStorage()
    entries.set('issue-graph:theme', 'not json')
    expect(readStored('issue-graph:theme', 'light')).toBe('light')
  })

  it('returns the fallback when reading throws, as it does in Safari private browsing', () => {
    installStorage({
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
    expect(readStored('issue-graph:theme', 'light')).toBe('light')
  })

  it('returns the fallback when there is no window at all', () => {
    removeWindow()
    expect(readStored('issue-graph:theme', 'light')).toBe('light')
  })
})

describe('writeStored', () => {
  it('stores the value as JSON', () => {
    const entries = installStorage()
    writeStored('issue-graph:theme', { mode: 'dark' })
    expect(entries.get('issue-graph:theme')).toBe('{"mode":"dark"}')
  })

  it('overwrites the previous value for the same key', () => {
    const entries = installStorage()
    writeStored('issue-graph:theme', 'light')
    writeStored('issue-graph:theme', 'dark')
    expect(entries.get('issue-graph:theme')).toBe('"dark"')
  })

  it('stays silent when the quota is exceeded', () => {
    installStorage({
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      },
    })
    expect(() => writeStored('issue-graph:theme', 'dark')).not.toThrow()
  })

  it('stays silent when there is no window at all', () => {
    removeWindow()
    expect(() => writeStored('issue-graph:theme', 'dark')).not.toThrow()
  })
})
