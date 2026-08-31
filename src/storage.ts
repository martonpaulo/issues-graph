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

export function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // A preference that cannot be remembered is not a reason to interrupt anything.
  }
}

export function clearStored(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Same reasoning as writeStored: storage being unavailable is not an error to surface.
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
