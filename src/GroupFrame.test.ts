import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { GraphGroup, IssueState } from './graph'
import { GroupFrame, type GroupFrameData } from './GroupFrame'

/**
 * The stylesheet is read as text rather than through a DOM: the suite runs under `node`, and what
 * has to be proved here is that a rule exists for every variant the components can emit. A frame
 * whose kind has no rule renders with no border and no background at all — it keeps its label and
 * stops being a frame — and nothing else in the suite can see that, because the class name is
 * still correct.
 */
const STYLES = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

const GROUP_KINDS: GraphGroup['kind'][] = ['chain', 'breakdown', 'free']

const ISSUE_STATES: IssueState[] = [
  'ready',
  'unassigned',
  'blocked',
  'in-progress',
  'attention',
  'in-review',
  'completed',
  'not-planned',
]

/** The declarations inside one rule, or null when the selector has no rule at all. */
function ruleBody(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(STYLES)
  return match ? match[1] : null
}

/**
 * No `ReactFlowProvider` here, unlike the card: a frame draws a div and a button and reads nothing
 * from the flow store, so rendering it needs neither the provider nor the import it costs.
 */
function renderFrame(group: GraphGroup, selected = false): string {
  const data: GroupFrameData = { group, selected, onSelect: () => {} }
  return renderToStaticMarkup(createElement(GroupFrame, { data } as never))
}

function group(overrides: Partial<GraphGroup> = {}): GraphGroup {
  return {
    id: 'group:acme/app#5',
    kind: 'chain',
    label: 'Chain · 2 issues',
    members: ['acme/app#5', 'acme/app#6'],
    position: { x: 0, y: 0 },
    width: 300,
    height: 200,
    ...overrides,
  }
}

describe('GroupFrame', () => {
  it('names its kind on the frame and its label on the button', () => {
    const html = renderFrame(group({ kind: 'breakdown', label: 'Breakdown · 2 issues' }))
    expect(html).toContain('class="group group--breakdown"')
    expect(html).toContain('Breakdown · 2 issues')
  })

  it.each(GROUP_KINDS)('draws a bounded, unselected %s frame', (kind) => {
    // The class the component emits has to reach a rule that actually bounds the frame. Without
    // one the group is invisible in its normal state and only its label survives.
    expect(renderFrame(group({ kind }))).toContain(`group group--${kind}`)

    const body = ruleBody(`.group--${kind}`)
    expect(body, `.group--${kind} has no rule in styles.css`).not.toBeNull()
    expect(body).toMatch(/\bborder:/)
    expect(body).toMatch(/\bbackground:/)
  })

  it('distinguishes containment from ordering by more than the label', () => {
    const chain = ruleBody('.group--chain')!
    const breakdown = ruleBody('.group--breakdown')!
    const free = ruleBody('.group--free')!

    // A breakdown is dashed like the hierarchy edges inside it, and filled like a chain, because
    // its members are one piece of work with no order between them.
    expect(breakdown).toContain('dashed')
    expect(chain).toContain('solid')
    expect(breakdown).not.toBe(chain)
    // Filled, which is what separates it from the set that is related by nothing at all.
    expect(free).toContain('background: none')
    expect(breakdown).not.toContain('background: none')
  })

  it('keeps a selected frame on the selection treatment whatever its kind', () => {
    for (const kind of GROUP_KINDS) {
      expect(renderFrame(group({ kind }), true)).toContain('group--selected')
    }
    expect(ruleBody('.group--selected')).not.toBeNull()
  })
})

describe('card state styles', () => {
  it.each(ISSUE_STATES)('fills a %s card, so no state falls back to a bare surface', (state) => {
    const body = ruleBody(`.card--${state}`)
    expect(body, `.card--${state} has no rule in styles.css`).not.toBeNull()
    expect(body).toMatch(/\bbackground:/)
    expect(body).toMatch(/\bborder-color:/)
  })
})
