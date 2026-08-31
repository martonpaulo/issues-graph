import { describe, expect, it } from 'vitest'

import { reuse } from './reuse'

describe('reuse', () => {
  it('hands back the previous whole when nothing in it changed', () => {
    const previous = [{ id: 'a', data: { selected: false } }]
    const next = [{ id: 'a', data: { selected: false } }]

    expect(reuse(previous, next)).toBe(previous)
  })

  it('keeps every unchanged member of a whole that did change', () => {
    const previous = [
      { id: 'a', data: { selected: false } },
      { id: 'b', data: { selected: false } },
    ]
    const next = [
      { id: 'a', data: { selected: true } },
      { id: 'b', data: { selected: false } },
    ]
    const merged = reuse(previous, next)

    expect(merged).not.toBe(previous)
    expect(merged[0]).not.toBe(previous[0])
    expect(merged[0].data.selected).toBe(true)
    expect(merged[1]).toBe(previous[1])
  })

  it('keeps the parts of a changed member that did not change', () => {
    const style = { width: 300, height: 90 }
    const previous = { id: 'a', style, data: { selected: false } }
    const next = { id: 'a', style: { ...style }, data: { selected: true } }
    const merged = reuse(previous, next)

    expect(merged).not.toBe(previous)
    expect(merged.style).toBe(style)
    expect(merged.data).not.toBe(previous.data)
  })

  it('follows a longer or shorter list without pretending the whole is unchanged', () => {
    const previous = [{ id: 'a' }]
    const grown = reuse(previous, [{ id: 'a' }, { id: 'b' }])

    expect(grown).not.toBe(previous)
    expect(grown[0]).toBe(previous[0])
    expect(grown[1]).toEqual({ id: 'b' })

    expect(reuse(previous, [])).toEqual([])
  })

  it('treats a value it cannot look into as changed when it is not the same value', () => {
    const previous = { members: new Set(['a']), onSelect: () => {} }
    const onSelect = previous.onSelect
    const merged = reuse(previous, { members: new Set(['a']), onSelect })

    // A rebuilt Set is a change: comparing it would mean knowing every container's contents.
    expect(merged).not.toBe(previous)
    // A callback that was not rebuilt is not.
    expect(merged.onSelect).toBe(onSelect)
  })

  it('is idempotent, so a render React runs twice reaches the same answer', () => {
    const previous = [{ id: 'a', data: { selected: false } }]
    const once = reuse(previous, [{ id: 'a', data: { selected: true } }])
    const twice = reuse(previous, [{ id: 'a', data: { selected: true } }])

    expect(reuse(once, twice)).toBe(once)
  })

  it('notices a field that appeared and one that went away', () => {
    const previous = { id: 'a', className: 'edge--lit' }

    expect(reuse(previous, { id: 'a' })).toEqual({ id: 'a' })
    expect(reuse({ id: 'a' }, previous)).toEqual(previous)
  })
})
