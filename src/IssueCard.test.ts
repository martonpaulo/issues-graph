import { ReactFlowProvider } from '@xyflow/react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { GraphNode } from './graph'
import { IssueCard, type IssueCardData } from './IssueCard'

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
): IssueCardData {
  return {
    node,
    selected: false,
    hidden: false,
    highlighted: false,
    faded: false,
    description,
    onSelect: () => {},
    onToggleHidden: () => {},
    onOpen: () => {},
  }
}

function renderCard(node: GraphNode, description?: string): string {
  return renderToStaticMarkup(
    createElement(ReactFlowProvider, null, createElement(IssueCard, {
      data: cardData(node, description),
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

function accessibleNames(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1])
}

describe('IssueCard', () => {
  it('announces a local issue by its number alone', () => {
    expect(accessibleNames(renderCard(issueNode({})))).toEqual([
      'Open #30 on GitHub',
      'Hide #30',
    ])
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
      'Hide other/lib#30',
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
