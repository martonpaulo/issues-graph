import { asString, clearStored, readStored, writeStored } from './storage'

/**
 * The viewer's own GitHub token.
 *
 * Unauthenticated reads share 60 per hour per IP address, which is what forces the dependency
 * phase to be rationed. A token the viewer supplies raises that to 5000 for them alone.
 *
 * It is the viewer's credential, not the product's: it is typed in by whoever is looking at the
 * page, kept only in their own browser, and sent only to api.github.com. Nothing here is
 * registered under the repository owner's account, and no backend holds anything.
 *
 * This module owns the storage key. Everything else asks for the value.
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 */

const TOKEN_KEY = 'issue-graph:token'

/** The stored token, or an empty string when none is set or storage cannot be read. */
export function readToken(): string {
  return readStored(TOKEN_KEY, asString, '').trim()
}

/**
 * Stores the token, or removes it when the text is blank. Clearing the field is how a viewer
 * takes their credential off the device, so it must not leave an empty one behind.
 */
export function writeToken(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    clearStored(TOKEN_KEY)
    return ''
  }
  writeStored(TOKEN_KEY, trimmed)
  return trimmed
}

export function clearToken(): void {
  clearStored(TOKEN_KEY)
}
