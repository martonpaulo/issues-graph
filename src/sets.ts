/**
 * Set combination, without the round trip through an array.
 *
 * The selection, dimming and highlight handlers all rebuild a set from another one, and the
 * obvious spelling — `new Set([...current].filter(...))` — builds two arrays on the way: one for
 * the spread and one for the filter. These do the same work by iterating the sets directly, which
 * matters because the handlers run on every click and keypress over a graph that can hold every
 * issue in a backlog.
 *
 * Both return a new set and mutate neither argument, so they are safe to use inside a React state
 * updater where the previous value must stay untouched.
 */

/** Everything in `base`, plus everything in `additions`. */
export function union<T>(base: ReadonlySet<T>, additions: Iterable<T>): Set<T> {
  const next = new Set(base)
  for (const value of additions) next.add(value)
  return next
}

/** Everything in `base` that `removals` does not hold. */
export function difference<T>(base: ReadonlySet<T>, removals: ReadonlySet<T>): Set<T> {
  const next = new Set<T>()
  for (const value of base) {
    if (!removals.has(value)) next.add(value)
  }
  return next
}
