import { describe, expect, it } from 'vitest'

import { difference, union } from './sets'

describe('union', () => {
  it('keeps the base members and adds the new ones', () => {
    expect([...union(new Set(['1', '2']), new Set(['3']))]).toEqual(['1', '2', '3'])
  })

  it('adds nothing twice', () => {
    expect([...union(new Set(['1', '2']), new Set(['2']))]).toEqual(['1', '2'])
  })

  it('leaves both arguments untouched', () => {
    const base = new Set(['1'])
    const additions = new Set(['2'])
    union(base, additions)
    expect([...base]).toEqual(['1'])
    expect([...additions]).toEqual(['2'])
  })

  it('accepts any iterable of additions', () => {
    expect([...union(new Set(['1']), ['2', '2', '3'])]).toEqual(['1', '2', '3'])
  })
})

describe('difference', () => {
  it('drops every member the second set holds', () => {
    expect([...difference(new Set(['1', '2', '3']), new Set(['2']))]).toEqual(['1', '3'])
  })

  it('ignores removals that were never present', () => {
    expect([...difference(new Set(['1']), new Set(['9']))]).toEqual(['1'])
  })

  it('returns an empty set when everything is removed', () => {
    expect(difference(new Set(['1', '2']), new Set(['1', '2'])).size).toBe(0)
  })

  it('leaves both arguments untouched', () => {
    const base = new Set(['1', '2'])
    const removals = new Set(['2'])
    difference(base, removals)
    expect([...base]).toEqual(['1', '2'])
    expect([...removals]).toEqual(['2'])
  })
})
