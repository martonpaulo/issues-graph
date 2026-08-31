/**
 * Small wrapper over localStorage. Every call is guarded: Safari in private browsing and any
 * blocked-storage setting throw on access, and a viewer that only remembers preferences must not
 * fail to render because of it.
 *
 * What comes back out of storage is `unknown`. The bytes were written by an older build, or by
 * hand in devtools, or corrupted in between, and none of that is visible to a type parameter: a
 * caller naming `string[]` gets a `string[]`-typed value regardless of what is actually there,
 * and the first `.map` outside this module is where it fails. So a read supplies a decoder that
 * inspects the parsed value and returns `undefined` when it is not the schema that feature
 * persists. Each feature owns the schema it writes; this module owns access, parsing, and the
 * primitive decoders those schemas are built from.
 */

/** Returns the decoded value, or `undefined` when the stored value is not this schema. */
export type Decoder<T> = (value: unknown) => T | undefined

export function readStored<T>(key: string, decode: Decoder<T>, fallback: T): T {
  let parsed: unknown
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    parsed = JSON.parse(raw)
  } catch {
    return fallback
  }

  // Outside the try on purpose: a decoder that throws is a defect in the decoder, not a storage
  // failure, and swallowing it here would hide it behind a fallback that looks like normal
  // behaviour.
  const decoded = decode(parsed)
  return decoded === undefined ? fallback : decoded
}

/**
 * What became of a write.
 *
 * A write is reported rather than swallowed because the two ways it fails mean different things
 * to the reader. Storage being unavailable — a private window, a blocked-storage setting — is a
 * standing condition nothing on the page can change. A full quota is a condition the page *can*
 * act on, by giving up something it saved earlier, and a caller that never learns the difference
 * cannot. The caller still decides whether a particular failure is worth saying out loud: a
 * preference that could not be remembered is not, and a graph that will cost GitHub requests to
 * read again is.
 */
export type StorageWriteResult =
  | { ok: true }
  | { ok: false; reason: 'quota' | 'unavailable'; message: string }

const WROTE: StorageWriteResult = { ok: true }

/**
 * Whether a thrown value is the browser saying the quota is full.
 *
 * The name is the modern spelling and the only one the standard defines; the legacy codes are
 * what older Firefox and older WebKit threw, and both are still reachable in browsers this page
 * is expected to run in.
 * https://developer.mozilla.org/en-US/docs/Web/API/Storage/setItem#exceptions
 */
function isQuotaFailure(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error.code === 22 ||
    error.code === 1014
  )
}

function failureOf(error: unknown): StorageWriteResult {
  return isQuotaFailure(error)
    ? { ok: false, reason: 'quota', message: 'This browser\u2019s storage is full.' }
    : {
        ok: false,
        reason: 'unavailable',
        message: 'This browser is not letting the page save anything.',
      }
}

export function writeStored(key: string, value: unknown): StorageWriteResult {
  return writeStoredText(key, JSON.stringify(value))
}

/**
 * The same write, given the serialized text.
 *
 * A caller that has to know how large a value is — the graph cache, which keeps a byte budget —
 * would otherwise serialize it once to measure and once more to store. The text is written
 * exactly as `writeStored` would have written it, so both paths round-trip through `readStored`
 * identically.
 */
export function writeStoredText(key: string, text: string): StorageWriteResult {
  try {
    window.localStorage.setItem(key, text)
    return WROTE
  } catch (error) {
    return failureOf(error)
  }
}

/**
 * Every key currently in storage, or nothing when the browser will not enumerate them.
 *
 * Needed because this page's own keys outlive any list it kept of them: builds before the
 * retention index wrote one key per repository and tracked only six names, so the rest are
 * discoverable from storage or not at all. Enumeration is guarded like every other access —
 * `length` and `key` are absent from some non-browser and stubbed storages, and an empty result
 * has to mean "cannot enumerate" rather than "nothing is stored", so callers treat it as no
 * information rather than as proof.
 */
export function storedKeys(): string[] {
  try {
    const storage = window.localStorage
    if (typeof storage.key !== 'function' || typeof storage.length !== 'number') return []

    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key !== null) keys.push(key)
    }
    return keys
  } catch {
    return []
  }
}

export function clearStored(key: string): StorageWriteResult {
  try {
    window.localStorage.removeItem(key)
    return WROTE
  } catch (error) {
    return failureOf(error)
  }
}

/* The primitive decoders. A feature composes these; the schema they are composed into stays with
   the feature that writes it. */

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined
  return value as string[]
}
