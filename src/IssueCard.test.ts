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
