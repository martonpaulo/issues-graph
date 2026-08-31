/**
 * Structural reuse: rebuild a value freely, then hand back the parts that did not actually change.
 *
 * React Flow decides what to re-render from object identity, so a canvas rebuilt from scratch on
 * every selection, dimming or highlight change presents every node and edge as new even when one
 * card moved. Comparing field by field at each call site would work and would be wrong the first
 * time somebody adds a field and forgets to compare it; this compares whatever is there.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function reuseArray(previous: readonly unknown[], next: readonly unknown[]): readonly unknown[] {
  let unchanged = previous.length === next.length
  const merged = next.map((value, index) => {
    if (index >= previous.length) return value
    const kept = reuse(previous[index], value)
    if (!Object.is(kept, previous[index])) unchanged = false
    return kept
  })
  return unchanged ? previous : merged
}

function reuseObject(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(next)
  let unchanged = keys.length === Object.keys(previous).length
  const merged: Record<string, unknown> = {}
  for (const key of keys) {
    if (!Object.hasOwn(previous, key)) {
      unchanged = false
      merged[key] = next[key]
      continue
    }
    const kept = reuse(previous[key], next[key])
    if (!Object.is(kept, previous[key])) unchanged = false
    merged[key] = kept
  }
  return unchanged ? previous : merged
}

/**
 * `next`, with every array element and plain-object field that is structurally identical to
 * `previous` replaced by the one `previous` already holds — so a whole that did not change comes
 * back as `previous` itself, and a whole that did keeps the references of its unchanged parts.
 *
 * Only arrays and plain objects are looked into. Anything else — a function, a `Set`, a class
 * instance, a primitive — is compared with `Object.is`, which means a rebuilt one counts as a
 * change. That is the safe direction: it re-renders something that need not have, rather than
 * holding on to a stale object that should have been replaced.
 *
 * The result is idempotent: `reuse(a, reuse(a, b))` is `reuse(a, b)`, which is what makes it safe
 * to apply during a render that React may run twice.
 */
export function reuse<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next
  if (Array.isArray(previous) && Array.isArray(next)) return reuseArray(previous, next) as T
  if (isPlainObject(previous) && isPlainObject(next)) return reuseObject(previous, next) as T
  return next
}
