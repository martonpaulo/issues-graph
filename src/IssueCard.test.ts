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
function renderCard(node: GraphNode): string {
  const data: IssueCardData = {
    node,
    selected: false,
    hidden: false,
    highlighted: false,
    faded: false,
    onSelect: () => {},
    onToggleHidden: () => {},
    onOpen: () => {},
  }

  return renderToStaticMarkup(
    createElement(ReactFlowProvider, null, createElement(IssueCard, { data } as never)),
  )
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
})
