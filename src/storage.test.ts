import { beforeEach, describe, expect, it } from 'vitest'

import {
  asBoolean,
  asString,
  asStringArray,
  clearStored,
  readStored,
  writeStored,
  writeStoredText,
} from './storage'

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

/**
 * A decoder that accepts anything, used where the test is about storage access rather than about
 * a schema. Every other test names the decoder it is actually exercising.
 */
const anything = (value: unknown): unknown => value

describe('readStored', () => {
  it('returns the fallback for a key that was never written', () => {
    expect(readStored('graph:layout', asString, 'vertical')).toBe('vertical')
  })

  it('reads back the value a write saved', () => {
    writeStored('graph:recent', ['martonpaulo/tabelo'])

    expect(readStored('graph:recent', asStringArray, [])).toEqual(['martonpaulo/tabelo'])
  })

  it('returns the fallback rather than throwing on text that is not JSON', () => {
    entries.set('graph:layout', 'vertical')

    expect(readStored('graph:layout', asString, 'horizontal')).toBe('horizontal')
  })

  it('returns the fallback rather than throwing when storage is unreadable', () => {
    installStorage({
      getItem: () => {
        throw new Error('storage blocked')
      },
    })

    expect(readStored('graph:layout', asString, 'vertical')).toBe('vertical')
  })

  // A stored `null` is a value that was written, not an absent key. Whether it survives is the
  // decoder's decision now, so a decoder that accepts it keeps it.
  it('keeps a stored null when the decoder accepts one', () => {
    writeStored('graph:repo', null)

    expect(
      readStored<string | null>(
        'graph:repo',
        (value) => (value === null || typeof value === 'string' ? value : undefined),
        'martonpaulo/tabelo',
      ),
    ).toBeNull()
  })

  it('returns the fallback when there is no window at all', () => {
    removeWindow()

    expect(readStored('graph:layout', asString, 'vertical')).toBe('vertical')
  })

  /* The point of the decoder: a value of the wrong shape must not reach the caller typed as
     though it had the right one. */

  it('returns the fallback when the decoder rejects the stored value', () => {
    writeStored('graph:show-closed', 'yes')

    expect(readStored('graph:show-closed', asBoolean, false)).toBe(false)
  })

  it('returns the fallback for an array holding something other than strings', () => {
    writeStored('graph:recent', ['martonpaulo/tabelo', 7, null])

    expect(readStored('graph:recent', asStringArray, [])).toEqual([])
  })

  it('returns the fallback for a container of the wrong kind entirely', () => {
    writeStored('graph:recent', { 0: 'martonpaulo/tabelo' })

    expect(readStored('graph:recent', asStringArray, [])).toEqual([])
  })

  it('hands the decoder the parsed value rather than the raw text', () => {
    writeStored('graph:filters', { closed: true })
    let seen: unknown

    readStored(
      'graph:filters',
      (value) => {
        seen = value
        return undefined
      },
      null,
    )

    expect(seen).toEqual({ closed: true })
  })

  it('leaves a value the decoder rejected in storage untouched', () => {
    writeStored('graph:show-closed', 'yes')
    readStored('graph:show-closed', asBoolean, false)

    expect(entries.get('graph:show-closed')).toBe('"yes"')
  })

  it('never calls the decoder for a key that was never written', () => {
    let calls = 0

    readStored(
      'graph:layout',
      (value) => {
        calls += 1
        return anything(value)
      },
      'vertical',
    )

    expect(calls).toBe(0)
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
    expect(readStored('graph:layout', asString, 'vertical')).toBe('horizontal')
  })

  it('reports that it wrote', () => {
    expect(writeStored('graph:layout', 'vertical')).toEqual({ ok: true })
  })

  it('reports rather than throws when storage refuses the write', () => {
    installStorage({
      setItem: () => {
        throw new Error('storage is blocked')
      },
    })

    expect(writeStored('graph:layout', 'vertical')).toEqual({
      ok: false,
      reason: 'unavailable',
      message: 'This browser is not letting the page save anything.',
    })
  })

  /* A full quota is told apart from every other refusal because the caller can act on it: the
     graph cache answers it by giving up an older repository and trying again, which would be the
     wrong response to a browser that is refusing to store anything at all. */

  it('names a full quota by the standard exception', () => {
    installStorage({
      setItem: () => {
        throw new DOMException('exceeded', 'QuotaExceededError')
      },
    })

    expect(writeStored('graph:layout', 'vertical')).toEqual({
      ok: false,
      reason: 'quota',
      message: 'This browser\u2019s storage is full.',
    })
  })

  it('names a full quota by the spelling older Firefox threw', () => {
    installStorage({
      setItem: () => {
        throw new DOMException('exceeded', 'NS_ERROR_DOM_QUOTA_REACHED')
      },
    })

    expect(writeStored('graph:layout', 'vertical')).toMatchObject({ reason: 'quota' })
  })

  it('reports rather than throws when there is no window at all', () => {
    removeWindow()

    expect(writeStored('issue-graph:theme', 'dark')).toMatchObject({ reason: 'unavailable' })
  })
})

describe('writeStoredText', () => {
  it('stores text that reads back exactly as the value form would have', () => {
    writeStoredText('graph:filters', JSON.stringify({ closed: true }))

    expect(entries.get('graph:filters')).toBe('{"closed":true}')
    expect(readStored('graph:filters', anything, null)).toEqual({ closed: true })
  })
})

describe('clearStored', () => {
  it('removes the key and reports that it did', () => {
    writeStored('graph:layout', 'vertical')

    expect(clearStored('graph:layout')).toEqual({ ok: true })
    expect(entries.has('graph:layout')).toBe(false)
  })

  it('reports rather than throws when storage refuses the removal', () => {
    installStorage({
      removeItem: () => {
        throw new Error('storage is blocked')
      },
    })

    expect(clearStored('graph:layout')).toMatchObject({ reason: 'unavailable' })
  })
})
