import { describe, expect, it } from 'vitest'

import { cardLabels, hasNamespace, MAX_CARD_LABELS, parseLabel, valueOf } from './labels'

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
  it('shows the meaningful namespaces in reading order and drops the noisy ones', () => {
    const chips = cardLabels([
      label('area: grid'),
      label('effort: M'),
      label('evidence: confirmed'),
      label('type: bug'),
      label('priority: P0'),
    ])
    // area and evidence are useful in the issue list and only crowd a card.
    expect(chips.map((chip) => chip.raw)).toEqual(['type: bug', 'priority: P0', 'effort: M'])
  })

  it('keeps a card compact', () => {
    const chips = cardLabels(
      ['type: bug', 'priority: P0', 'effort: M', 'status: blocked', 'area: grid', 'extra'].map(
        label,
      ),
    )
    expect(chips).toHaveLength(MAX_CARD_LABELS)
    expect(chips.every((chip) => chip.namespace !== 'area')).toBe(true)
  })

  it('falls back to plain labels so a repository using no namespaces still shows something', () => {
    expect(cardLabels([label('enhancement'), label('bug')]).map((chip) => chip.value)).toEqual([
      'enhancement',
      'bug',
    ])
  })

  it('hides plain labels once namespaced ones are present', () => {
    expect(cardLabels([label('enhancement'), label('type: bug')]).map((chip) => chip.raw)).toEqual([
      'type: bug',
    ])
  })
})

describe('hasNamespace and valueOf', () => {
  it('detects a status label, which is what marks an issue as needing attention', () => {
    expect(hasNamespace([label('status: needs-decision')], 'status')).toBe(true)
    expect(hasNamespace([label('effort: L')], 'status')).toBe(false)
  })

  it('reads a namespace value back', () => {
    expect(valueOf(cardLabels([label('effort: L')]), 'effort')).toBe('L')
    expect(valueOf(cardLabels([label('effort: L')]), 'priority')).toBeNull()
  })
})
