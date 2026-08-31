import { beforeEach, describe, expect, it } from 'vitest'

import { clearToken, readToken, writeToken } from './token'

/**
 * As in cache.test.ts, the tests run under the `node` environment, so `window.localStorage` has to
 * be supplied. What matters here is what token.ts round-trips through it.
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

describe('the viewer’s token', () => {
  let entries: Map<string, string>

  beforeEach(() => {
    entries = installStorage()
  })

  it('round-trips a token', () => {
    expect(writeToken('github_pat_example')).toBe('github_pat_example')
    expect(readToken()).toBe('github_pat_example')
  })

  it('reads an empty string when nothing was ever stored', () => {
    expect(readToken()).toBe('')
  })

  it('trims what is pasted, because a copied token usually arrives with whitespace', () => {
    writeToken('  github_pat_example\n')
    expect(readToken()).toBe('github_pat_example')
  })

  it('treats a blank value as a removal rather than storing an empty credential', () => {
    writeToken('github_pat_example')
    expect(writeToken('   ')).toBe('')
    expect(readToken()).toBe('')
    expect([...entries.keys()]).toEqual([])
  })

  it('removes the token from the device when cleared', () => {
    writeToken('github_pat_example')
    clearToken()
    expect(readToken()).toBe('')
    expect([...entries.keys()]).toEqual([])
  })

  it('reads nothing rather than throwing when storage is unavailable', () => {
    installStorage({
      getItem: () => {
        throw new Error('storage is blocked')
      },
      setItem: () => {
        throw new Error('storage is blocked')
      },
    })

    expect(() => writeToken('github_pat_example')).not.toThrow()
    expect(readToken()).toBe('')
  })

  it('reads nothing when the stored value is not a string', () => {
    entries.set('issue-graph:token', JSON.stringify({ token: 'github_pat_example' }))
    expect(readToken()).toBe('')
  })

  it('reads nothing rather than throwing on stored text that is not JSON', () => {
    entries.set('issue-graph:token', 'github_pat_example')
    expect(readToken()).toBe('')
  })
})
