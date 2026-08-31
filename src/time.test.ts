import { describe, expect, it } from 'vitest'

import { describeAge, describeUntil } from './time'

const now = new Date('2026-08-25T12:00:00Z')
const before = (ms: number) => new Date(now.getTime() - ms)
const after = (ms: number) => new Date(now.getTime() + ms)

describe('describeAge', () => {
  it('uses the largest unit that still reads naturally', () => {
    expect(describeAge(before(20 * 1000), now)).toBe('just now')
    expect(describeAge(before(60 * 1000), now)).toBe('1 minute ago')
    expect(describeAge(before(42 * 60 * 1000), now)).toBe('42 minutes ago')
    expect(describeAge(before(3 * 3600 * 1000), now)).toBe('3 hours ago')
    expect(describeAge(before(50 * 3600 * 1000), now)).toBe('2 days ago')
  })

  it('rolls into the next unit rather than naming its boundary', () => {
    expect(describeAge(before(59 * 60 * 1000 + 29 * 1000), now)).toBe('59 minutes ago')
    expect(describeAge(before(59 * 60 * 1000 + 30 * 1000), now)).toBe('1 hour ago')
    expect(describeAge(before(23 * 3600 * 1000 + 29 * 60 * 1000), now)).toBe('23 hours ago')
    expect(describeAge(before(23 * 3600 * 1000 + 30 * 60 * 1000), now)).toBe('1 day ago')
  })

  it('keeps the sub-minute wording either side of the first boundary', () => {
    expect(describeAge(before(59 * 1000), now)).toBe('just now')
    expect(describeAge(before(60 * 1000), now)).toBe('1 minute ago')
  })

  it('never reports a copy as saved in the future', () => {
    expect(describeAge(after(60_000), now)).toBe('just now')
  })
})

describe('describeUntil', () => {
  it('counts down rather than naming a wall-clock time', () => {
    expect(describeUntil(after(23 * 60 * 1000), now)).toBe('in 23 minutes')
    expect(describeUntil(after(60 * 1000), now)).toBe('in 1 minute')
    expect(describeUntil(after(30 * 1000), now)).toBe('in under a minute')
    expect(describeUntil(after(2 * 3600 * 1000), now)).toBe('in 2 hours')
  })

  it('applies the same boundary policy as the age wording', () => {
    expect(describeUntil(after(59 * 60 * 1000 + 29 * 1000), now)).toBe('in 59 minutes')
    expect(describeUntil(after(59 * 60 * 1000 + 30 * 1000), now)).toBe('in 1 hour')
    expect(describeUntil(after(23 * 3600 * 1000 + 29 * 60 * 1000), now)).toBe('in 23 hours')
    expect(describeUntil(after(23 * 3600 * 1000 + 30 * 60 * 1000), now)).toBe('in 1 day')
    expect(describeUntil(after(59 * 1000), now)).toBe('in under a minute')
  })

  it('says so plainly when the moment has passed or is unknown', () => {
    expect(describeUntil(before(1000), now)).toBe('now')
    expect(describeUntil(null, now)).toBe('shortly')
  })
})
