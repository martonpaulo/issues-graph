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

/** How long ago something happened: "just now", "4 minutes ago", "2 days ago". */
export function describeAge(moment: Date, now: Date = new Date()): string {
  const elapsed = Math.max(0, now.getTime() - moment.getTime())
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return `${plural(Math.round(elapsed / MINUTE), 'minute')} ago`
  if (elapsed < DAY) return `${plural(Math.round(elapsed / HOUR), 'hour')} ago`
  return `${plural(Math.round(elapsed / DAY), 'day')} ago`
}

/** How long until something happens: "in 23 minutes". Null when the moment is unknown. */
export function describeUntil(moment: Date | null, now: Date = new Date()): string {
  if (!moment) return 'shortly'
  const remaining = moment.getTime() - now.getTime()
  if (remaining <= 0) return 'now'
  if (remaining < MINUTE) return 'in under a minute'
  if (remaining < HOUR) return `in ${plural(Math.round(remaining / MINUTE), 'minute')}`
  if (remaining < DAY) return `in ${plural(Math.round(remaining / HOUR), 'hour')}`
  return `in ${plural(Math.round(remaining / DAY), 'day')}`
}
