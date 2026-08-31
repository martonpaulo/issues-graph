import { ReactFlowProvider } from '@xyflow/react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { GraphNode } from './graph'
import { IssueCard, type IssueCardData } from './IssueCard'
import { chipPalette } from './labelColor'
import { cardLabels } from './labels'

function issueNode(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: 'owner/app#30',
    number: 30,
    title: 'Draw the blocking order',
    url: 'https://github.com/owner/app/issues/30',
    repo: 'owner/app',
    state: 'ready',
    open: true,
    external: false,
    repoLabel: '',
    labels: [],
    allLabels: [],
    subIssues: null,
    titleLines: 1,
    height: 100,
    position: { x: 0, y: 0 },
    ...overrides,
  }
}

/**
 * `IssueCard` draws `@xyflow/react` handles, which read the flow store, so the provider is what
 * makes a bare render possible at all.
 */
function cardData(
  node: GraphNode,
  description = 'Issue #30. Blocked by nothing. Blocks nothing.',
  dimmed = false,
): IssueCardData {
  return {
    node,
    selected: false,
    dimmed,
    highlighted: false,
    faded: false,
    description,
    onSelect: () => {},
    onToggleDimmed: () => {},
    onOpen: () => {},
  }
}

function renderCard(node: GraphNode, description?: string, dimmed = false): string {
  return renderToStaticMarkup(
    createElement(ReactFlowProvider, null, createElement(IssueCard, {
      data: cardData(node, description, dimmed),
    } as never)),
  )
}

/** The ids the cards point their descriptions at, in document order. */
function describedIds(html: string): string[] {
  return [...html.matchAll(/aria-describedby="([^"]*)"/g)].map((match) => match[1])
}

/**
 * What a button's accessible name is computed from: everything between its tags. Clipped text
 * counts — `.sr-only` hides from the eye, not from the accessibility tree.
 */
function buttonContents(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1])
}

/** The chips a card drew, in document order, with their markup stripped. */
function chips(html: string): string[] {
  return [...html.matchAll(/<span class="chip[^"]*"[^>]*>([\s\S]*?)<\/span>/g)].map(
    (match) => match[1],
  )
}

function accessibleNames(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1])
}

describe('IssueCard', () => {
  it('announces a local issue by its number alone', () => {
    expect(accessibleNames(renderCard(issueNode({})))).toEqual([
      'Open #30 on GitHub',
      'Dim #30',
    ])
  })

  it('names the toggle for what it does to the card, in both directions', () => {
    const lit = renderCard(issueNode({}))
    expect(lit).toContain('aria-label="Dim #30"')
    expect(lit).toContain('data-tip="Dim this issue \u00b7 D"')
    expect(lit).toContain('aria-pressed="false"')
    expect(lit).not.toContain('card--dimmed')

    // The card is still drawn, still reachable and still announced: only its emphasis drops, so
    // the control says "restore" rather than "show".
    const dim = renderCard(issueNode({}), undefined, true)
    expect(dim).toContain('aria-label="Restore #30"')
    expect(dim).toContain('data-tip="Restore this issue \u00b7 R"')
    expect(dim).toContain('aria-pressed="true"')
    expect(dim).toContain('card--dimmed')
    expect(dim).not.toContain('aria-hidden="true" class="card"')
    expect(dim).toContain('Draw the blocking order')
  })

  it('announces an external issue with its repository named once', () => {
    const html = renderCard(
      issueNode({
        id: 'other/lib#30',
        repo: 'other/lib',
        external: true,
        repoLabel: 'other/lib',
        state: null,
        url: 'https://github.com/other/lib/issues/30',
      }),
    )

    expect(accessibleNames(html)).toEqual([
      'Open other/lib#30 on GitHub',
      'Dim other/lib#30',
    ])
    expect(html).toContain('<span class="card__repo">other/lib</span>')
  })

  it('writes every state as a word, so colour is never the only carrier', () => {
    const words: Record<string, string> = {
      ready: 'ready',
      unassigned: 'unassigned',
      blocked: 'blocked',
      'in-progress': 'in progress',
      attention: 'needs attention',
      'in-review': 'delivered',
      completed: 'closed',
      'not-planned': 'not planned',
    }

    for (const [state, word] of Object.entries(words)) {
      const html = renderCard(issueNode({ state: state as GraphNode['state'] }))
      expect(html).toContain(`<span class="card__state">${word}</span>`)
      expect(html).toContain(`card--${state}`)
    }
    // "delivered", not "in review": the reader is asking what to pick up, and this one is written.
    expect(words['in-review']).not.toBe(words.ready)
  })

  /** The chips a repository keeping the `namespace: value` convention produces. */
  it('leads with the canonical slots, marks the missing one, and still draws the rest', () => {
    const html = renderCard(
      issueNode({
        labels: cardLabels([
          { name: 'type: bug', color: 'd73a4a' },
          { name: 'priority: P1', color: 'b60205' },
          { name: 'area: grid', color: 'c5def5' },
        ]),
      }),
    )

    expect(chips(html)).toEqual(['type: bug', 'priority: P1', 'effort', 'area: grid'])
    // The gap is drawn as a gap, so the missing estimate reads as missing rather than as absent.
    expect(html).toContain('<span class="chip chip--empty">effort</span>')
    // And a filled slot is painted from its own label's colour, like any other chip.
    expect(html).toContain('chip chip--painted')
  })

  /**
   * The regression this card was rebuilt for: a repository with its own naming scheme used to get
   * three dashed slots and none of the labels its issues actually carry.
   */
  it("draws an arbitrary repository's own labels instead of gaps for a taxonomy it has not got", () => {
    const html = renderCard(
      issueNode({
        labels: cardLabels([
          { name: 'bug', color: 'd73a4a' },
          { name: 'good first issue', color: '7057ff' },
          { name: '🐛 needs repro', color: '000000' },
        ]),
      }),
    )

    expect(chips(html)).toEqual(['bug', 'good first issue', '🐛 needs repro'])
    expect(html).not.toContain('chip--empty')
  })

  it("paints a chip in the pair derived from its label's own colour", () => {
    const html = renderCard(
      issueNode({ labels: cardLabels([{ name: 'bug', color: 'd73a4a' }]) }),
    )
    const palette = chipPalette('d73a4a')!

    expect(html).toContain('chip--painted')
    expect(html).toContain(`background:${palette.background}`)
    expect(html).toContain(`color:${palette.foreground}`)
    expect(html).toContain(`border-color:${palette.border}`)
  })

  it('leaves an empty slot and an unusable colour to the stylesheet', () => {
    // An empty slot is the card's own colour, not a label's; a payload carrying no usable hex —
    // a hand-written shared link, an older cached copy — falls back to the same treatment.
    const empty = renderCard(
      issueNode({ labels: cardLabels([{ name: 'type: bug', color: 'd73a4a' }, { name: 'priority: P1', color: 'b60205' }]) }),
    )
    expect(empty).toContain('<span class="chip chip--empty">effort</span>')

    const unusable = renderCard(
      issueNode({ labels: cardLabels([{ name: 'bug', color: 'not-a-colour' }]) }),
    )
    expect(unusable).toContain('<span class="chip">bug</span>')
    expect(unusable).not.toContain('chip--painted')
  })

  it('escapes a label rather than letting its text reach the markup', () => {
    const html = renderCard(
      issueNode({ labels: cardLabels([{ name: '<script>x</script>', color: '000000' }]) }),
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('draws no chips at all for a card carrying no labels', () => {
    expect(chips(renderCard(issueNode({})))).toEqual([])
  })

  it('shows a parent its own progress in words, and shows nothing on an issue with no children', () => {
    expect(renderCard(issueNode({ subIssues: { completed: 2, total: 5 } }))).toContain(
      '<span class="card__progress">2 of 5 done</span>',
    )
    expect(renderCard(issueNode({}))).not.toContain('card__progress')
  })

  it('keeps the repository casing GitHub reported, still naming it once', () => {
    expect(
      accessibleNames(
        renderCard(
          issueNode({
            id: 'Other/Lib#30',
            repo: 'Other/Lib',
            external: true,
            repoLabel: 'Other/Lib',
            state: null,
            url: 'https://github.com/Other/Lib/issues/30',
          }),
        ),
      )[0],
    ).toBe('Open Other/Lib#30 on GitHub')
  })

  it('describes its blockers and dependents where colour and geometry cannot', () => {
    const html = renderCard(
      issueNode({}),
      'Issue #30. Blocked by #23 and #24. Blocks #31.',
    )

    // The reference has to resolve, whatever the id is spelled as.
    const [described] = describedIds(html)
    expect(described).toBeDefined()
    expect(html).toContain(
      `<span class="sr-only" id="${described}">Issue #30. Blocked by #23 and #24. Blocks #31.</span>`,
    )
  })

  /**
   * A button's name is computed from its contents and `.sr-only` is clipped from view but not
   * from the accessibility tree, so the sentence inside the button would be announced as part of
   * the name and then again as the description.
   */
  it('describes the card without also naming it that', () => {
    const html = renderCard(
      issueNode({}),
      'Issue #30. Blocked by #23 and #24. Blocks #31.',
    )

    for (const contents of buttonContents(html)) {
      expect(contents).not.toContain('Blocked by')
    }
    // Still present on the card, just not inside anything that names itself from it.
    expect(html).toContain('Issue #30. Blocked by #23 and #24. Blocks #31.')
  })

  /**
   * `acme/foo-bar#1` and `acme-foo/bar#1` are both identities GitHub can produce, and any id
   * folding `/` and `#` into a safe character maps them onto one string. Two cards sharing an id
   * would leave one described by the other's blockers, which is worse than describing neither.
   */
  it('gives two cards distinct ids even where their identities fold together', () => {
    const html = renderToStaticMarkup(
      createElement(
        ReactFlowProvider,
        null,
        createElement(IssueCard, {
          data: cardData(
            issueNode({ id: 'acme/foo-bar#1', number: 1, repo: 'acme/foo-bar' }),
            'Issue #1. Blocked by nothing. Blocks nothing.',
          ),
        } as never),
        createElement(IssueCard, {
          data: cardData(
            issueNode({
              id: 'acme-foo/bar#1',
              number: 1,
              repo: 'acme-foo/bar',
              external: true,
              repoLabel: 'acme-foo/bar',
              state: null,
            }),
            'Issue acme-foo/bar#1. Blocked by nothing. Blocks #1.',
          ),
        } as never),
      ),
    )

    const ids = describedIds(html)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)

    // And each reference still resolves to its own card's sentence.
    expect(html).toContain(
      `<span class="sr-only" id="${ids[0]}">Issue #1. Blocked by nothing. Blocks nothing.</span>`,
    )
    expect(html).toContain(
      `<span class="sr-only" id="${ids[1]}">Issue acme-foo/bar#1. Blocked by nothing. Blocks #1.</span>`,
    )
  })
})
