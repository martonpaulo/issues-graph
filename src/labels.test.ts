import { describe, expect, it } from 'vitest'

import { cardLabels, needsAttention, parseLabel } from './labels'

const label = (name: string) => ({ name, color: 'cccccc' })

const texts = (names: string[]) => cardLabels(names.map(label)).map((chip) => chip.text)

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

describe('cardLabels on a backlog that keeps the convention', () => {
  it('leads with the three namespaces, in reading order', () => {
    expect(
      texts([
        'area: grid',
        'effort: M',
        'evidence: confirmed',
        'type: bug',
        'priority: P0',
      ]).slice(0, 3),
    ).toEqual(['type: bug', 'priority: P0', 'effort: M'])
  })

  it('marks a slot the issue has no label for, rather than leaving it out', () => {
    // Two of the three namespaces is the evidence that the gap means something here.
    expect(texts(['type: bug', 'priority: P0'])).toEqual(['type: bug', 'priority: P0', 'effort'])
    expect(cardLabels([label('type: bug'), label('priority: P0')])[2]).toMatchObject({
      namespace: 'effort',
      empty: true,
    })
  })

  it('still draws the rest of a heavily labelled issue, after the three', () => {
    // The card is the primary view of an issue: a label it drops is metadata the reader has not
    // got. `graph.ts` pays for the rows these wrap onto.
    expect(
      texts([
        'area: grid',
        'type: bug',
        'evidence: confirmed',
        'priority: P0',
        'enhancement',
        'effort: M',
      ]),
    ).toEqual([
      'type: bug',
      'priority: P0',
      'effort: M',
      'area: grid',
      'evidence: confirmed',
      'enhancement',
    ])
  })
})

describe('cardLabels on a backlog that does not', () => {
  it('draws the labels a plain repository actually uses', () => {
    expect(texts(['bug', 'good first issue', 'help wanted'])).toEqual([
      'bug',
      'good first issue',
      'help wanted',
    ])
  })

  it('invents no gaps for a taxonomy the issue gives no evidence of', () => {
    // One namespace is not a convention: dashed `type` and `priority` slots would assert something
    // about this repository that nothing supports, and would push `enhancement` off the card.
    expect(texts(['effort: M', 'enhancement'])).toEqual(['effort: M', 'enhancement'])
    expect(cardLabels([label('effort: M'), label('enhancement')]).every((chip) => !chip.empty)).toBe(
      true,
    )
    expect(texts([])).toEqual([])
  })

  it('keeps a namespace it recognizes in front of the ones it does not', () => {
    expect(texts(['Component: DevTools', 'Type: Bug', 'Status: Unconfirmed'])).toEqual([
      'Type: Bug',
      'Component: DevTools',
      'Status: Unconfirmed',
    ])
  })

  it("draws a label exactly as its repository spells it", () => {
    // Not a re-rendered `namespace: value`: `Type:Bug` is that repository's own text.
    expect(texts(['Type:Bug', 'priority: high'])).toEqual(['Type:Bug', 'priority: high', 'effort'])
  })

  it('carries a long, punctuated or emoji label through untouched', () => {
    const long = 'a'.repeat(50)
    expect(texts([long, '🐛 bug', 'C++ / stdlib'])).toEqual([long, '🐛 bug', 'C++ / stdlib'])
  })

  it('draws every label, in the order GitHub reported them', () => {
    const many = Array.from({ length: 12 }, (_, index) => `label-${index}`)
    expect(texts(many)).toEqual(many)
  })

  it('marks a namespace slot as canonical and every other chip as plain', () => {
    const chips = cardLabels([label('type: bug'), label('priority: P1'), label('enhancement')])
    expect(chips.map((chip) => chip.namespace)).toEqual(['type', 'priority', 'effort', null])
    expect(cardLabels([label('enhancement')]).map((chip) => chip.namespace)).toEqual([null])
  })
})

describe('needsAttention', () => {
  it('recognizes the two values the convention actually defines', () => {
    expect(needsAttention([label('status: needs-decision')])).toBe(true)
    expect(needsAttention([label('status: blocked')])).toBe(true)
    expect(needsAttention([label('Status:Needs-Decision')])).toBe(true)
    expect(needsAttention([label('effort: L')])).toBe(false)
    expect(needsAttention([])).toBe(false)
  })

  /**
   * `status:` is a namespace half of GitHub uses for a board column, and a board column is not an
   * exception waiting on anybody. Reading the namespace alone showed every issue on such a board
   * as needing attention, which is the loudest state the card has.
   */
  it('says nothing about a repository using the namespace for its board', () => {
    for (const name of [
      'status: backlog',
      'status: accepted',
      'status: triage',
      'status: in progress',
      'status: ready',
      'status: done',
    ]) {
      expect(needsAttention([label(name)])).toBe(false)
    }
  })

  it('reads the value on its own terms, not as a prefix of one it knows', () => {
    expect(needsAttention([label('status: blocked-upstream')])).toBe(false)
    expect(needsAttention([label('status: not blocked')])).toBe(false)
    // A bare label is not a namespaced one, whatever it is called.
    expect(needsAttention([label('blocked')])).toBe(false)
  })
})
