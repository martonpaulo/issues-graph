/**
 * Relative wall-clock wording, in one place.
 *
 * Everything the viewer says about time is relative on purpose: "refills in 23 minutes" answers
 * the question the reader actually has — how long until I can read again — while "refills 10:38 PM"
 * makes them work it out, and is ambiguous across a device whose clock or timezone differs.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}

/**
 * The quantity phrase for a span, at or above one minute: "1 minute", "59 minutes", "1 hour".
 *
 * The rounding rule, which both callers share so age and countdown cannot drift apart: round the
 * span to the nearest whole unit, half away from zero. When the rounded value reaches the next
 * unit's boundary — 60 minutes, 24 hours — express the span in that next unit instead, rounding
 * again there. Choosing the unit before rounding is what produced "60 minutes" and "24 hours".
 */
function describeSpan(span: number): string {
  const minutes = Math.round(span / MINUTE)
  if (minutes < 60) return plural(minutes, 'minute')
  const hours = Math.round(span / HOUR)
  if (hours < 24) return plural(hours, 'hour')
  return plural(Math.round(span / DAY), 'day')
}

/** How long ago something happened: "just now", "4 minutes ago", "2 days ago". */
export function describeAge(moment: Date, now: Date = new Date()): string {
  const elapsed = Math.max(0, now.getTime() - moment.getTime())
  if (elapsed < MINUTE) return 'just now'
  return `${describeSpan(elapsed)} ago`
}

/** How long until something happens: "in 23 minutes". Null when the moment is unknown. */
export function describeUntil(moment: Date | null, now: Date = new Date()): string {
  if (!moment) return 'shortly'
  const remaining = moment.getTime() - now.getTime()
  if (remaining <= 0) return 'now'
  if (remaining < MINUTE) return 'in under a minute'
  return `in ${describeSpan(remaining)}`
}
