import { describe, expect, it } from 'vitest'

import { cardLabels, chipText, hasNamespace, parseLabel, parseLabels, valueOf } from './labels'

const label = (name: string) => ({ name, color: 'cccccc' })

describe('parseLabel', () => {
  it('splits the namespace convention both repositories use', () => {
    expect(parseLabel(label('priority: P1'))).toMatchObject({ namespace: 'priority', value: 'P1' })
    expect(parseLabel(label('effort: L'))).toMatchObject({ namespace: 'effort', value: 'L' })
    expect(parseLabel(label('status: needs-decision'))).toMatchObject({
      namespace: 'status',
      value: 'needs-decision',
    })
  })

  it('leaves an unprefixed label whole so plain repositories still render', () => {
    expect(parseLabel(label('enhancement'))).toMatchObject({
      namespace: null,
      value: 'enhancement',
    })
  })

  it('does not treat a colon inside prose as a namespace', () => {
    expect(parseLabel(label('needs triage: urgent')).namespace).toBeNull()
  })
})

describe('cardLabels', () => {
  it('always returns the same three slots, in reading order', () => {
    const chips = cardLabels([
      label('area: grid'),
      label('effort: M'),
      label('evidence: confirmed'),
      label('type: bug'),
      label('priority: P0'),
    ])
    expect(chips.map(chipText)).toEqual(['type: bug', 'priority: P0', 'effort: M'])
  })

  it('marks a slot the issue has no label for, rather than leaving it out', () => {
    expect(cardLabels([label('type: bug')]).map(chipText)).toEqual([
      'type: bug',
      'priority',
      'effort',
    ])
    expect(cardLabels([]).map(chipText)).toEqual(['type', 'priority', 'effort'])
  })

  it('keeps everything else off the card', () => {
    const chips = cardLabels([label('enhancement'), label('area: grid'), label('type: bug')])
    expect(chips).toHaveLength(3)
    expect(chips.some((chip) => chip.value === 'enhancement')).toBe(false)
  })
})

describe('hasNamespace and valueOf', () => {
  it('detects a status label, which is what marks an issue as needing attention', () => {
    expect(hasNamespace([label('status: needs-decision')], 'status')).toBe(true)
    expect(hasNamespace([label('effort: L')], 'status')).toBe(false)
  })

  it('reads a namespace value back', () => {
    expect(valueOf(parseLabels([label('effort: L')]), 'effort')).toBe('L')
    expect(valueOf(parseLabels([label('effort: L')]), 'priority')).toBeNull()
  })
})
