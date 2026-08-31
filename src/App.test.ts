import { readFileSync } from 'node:fs'

import { ReactFlowProvider } from '@xyflow/react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import arbaroBlockedBy from './__fixtures__/arbaro.blocked-by.json'
import arbaroIssues from './__fixtures__/arbaro.issues.json'
import {
  App,
  blockerStateText,
  DependencyTable,
  DIRECTION_LEGEND,
  budgetParts,
  canvasShortcut,
  describeClear,
  describeSavedCopy,
  describeShare,
  describeUnresolved,
  dimmedKey,
  failureText,
  graphBounds,
  nextIssueSelection,
  SelectionBar,
  TopChrome,
} from './App'
import { decideSavedCopyOpen, describeSaveProblem } from './graphSession'
import { readCache, writeCache } from './cache'
import { buildSnapshotUrl } from './snapshot'
import type { IssuePayload, RepositoryGraphData } from './github'
import { dependencyRows, issueRef } from './dependencies'
import { buildGraph, NODE_WIDTH, type GraphNode, type IssueGraph } from './graph'

const narrowData: RepositoryGraphData = {
  issues: [],
  blockers: new Map(),
  complete: true,
  unresolved: [],
  rateLimited: false,
  rateLimitReset: null,
  requestCount: 1,
  rateLimit: null,
  includedClosed: false,
}

function withBrowserStorage<T>(run: () => T, hash = ''): T {
  const values = new Map<string, string>()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const localStorage: Storage = {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage,
      location: { pathname: '/dependencies/acme/app', search: '', hash },
      history: { replaceState: () => {} },
    },
  })

  try {
    return run()
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

describe('nextIssueSelection', () => {
  it('replaces the selection for an ordinary issue click', () => {
    expect([...nextIssueSelection(new Set(['1', '2']), '3', false)]).toEqual(['3'])
    expect([...nextIssueSelection(new Set(['1', '2']), '2', false)]).toEqual(['2'])
  })

  it('toggles one issue for a modified click', () => {
    expect([...nextIssueSelection(new Set(['1']), '2', true)]).toEqual(['1', '2'])
    expect([...nextIssueSelection(new Set(['1', '2']), '2', true)]).toEqual(['1'])
  })
})

describe('saved copy entry', () => {
  it('keeps initial and refreshed visits at the choice gate when a copy exists', () => {
    withBrowserStorage(() => {
      writeCache('acme/app', narrowData)

      for (const visit of [1, 2]) {
        const html = renderToStaticMarkup(createElement(App))
        expect(html, `visit ${visit}`).toContain('Fetch now')
        expect(html, `visit ${visit}`).toContain('Open saved copy')
        expect(html, `visit ${visit}`).not.toContain('Issue dependency graph for acme/app')
      }
    })
  })

  it('offers to clear the saved data exactly where there is saved data to clear', () => {
    withBrowserStorage(() => {
      expect(renderToStaticMarkup(createElement(App))).not.toContain('Clear saved data')

      writeCache('acme/app', narrowData)
      expect(renderToStaticMarkup(createElement(App))).toContain('Clear saved data')
    })
  })

  it('cannot open an open-only copy as a complete closed-blocker view', () => {
    withBrowserStorage(() => {
      writeCache('acme/app', narrowData)
      const cached = readCache('acme/app')
      expect(cached).not.toBeNull()
      if (!cached) return

      expect(decideSavedCopyOpen(cached, false).kind).toBe('open')
      expect(decideSavedCopyOpen(cached, true)).toEqual({
        kind: 'requires-latest',
        reason: 'A wider GitHub read is required to include closed blockers.',
      })
      window.localStorage.setItem('issue-graph:show-closed', 'true')
      const html = renderToStaticMarkup(createElement(App))
      expect(html).toContain(
        'type="button" disabled="" aria-describedby="saved-copy-unavailable"',
      )
      expect(html).toContain('A wider GitHub read is required to include closed blockers.')
      expect(html).not.toContain('Issue dependency graph for acme/app')
      expect(
        decideSavedCopyOpen(
          { ...cached, data: { ...cached.data, includedClosed: true } },
          true,
        ).kind,
      ).toBe('open')
    })
  })

  it('never offers the budget gate when the address carries a shared link', async () => {
    const link = await buildSnapshotUrl(
      'acme/app',
      { data: narrowData, capturedAt: new Date(), showClosed: false },
      '',
      '/',
    )
    expect(link.kind).toBe('ready')
    if (link.kind !== 'ready') return

    withBrowserStorage(() => {
      // A saved copy exists too, so the only reason the gate could be absent is the fragment.
      writeCache('acme/app', narrowData)
      const html = renderToStaticMarkup(createElement(App))

      expect(html).not.toContain('Fetch now')
      expect(html).not.toContain('Open saved copy')
      expect(html).not.toContain('Reading costs GitHub requests')
    }, link.url.slice(link.url.indexOf('#')))
  })

  it('describes a saved canvas with its age and dependency coverage', () => {
    const now = new Date('2026-08-30T08:00:00Z')
    const savedAt = new Date('2026-08-30T06:00:00Z')

    expect(describeSavedCopy({ savedAt, includedClosed: false, source: 'saved' }, now)).toBe(
      'Saved copy · 2 hours ago · open blockers only',
    )
    expect(describeSavedCopy({ savedAt, includedClosed: true, source: 'saved' }, now)).toBe(
      'Saved copy · 2 hours ago · includes closed blockers',
    )
  })

  it('says a copy that arrived in a link is not the viewer\u2019s own', () => {
    const now = new Date('2026-08-30T08:00:00Z')
    const savedAt = new Date('2026-08-30T06:00:00Z')

    expect(describeSavedCopy({ savedAt, includedClosed: false, source: 'shared' }, now)).toBe(
      'Shared copy · 2 hours ago · open blockers only',
    )
    expect(describeSavedCopy({ savedAt, includedClosed: true, source: 'shared' }, now)).toBe(
      'Shared copy · 2 hours ago · includes closed blockers',
    )
  })
})

describe('describeClear', () => {
  it('names the repository that was cleared and says the others were not', () => {
    expect(describeClear({ ok: true }, 'martonpaulo/tabelo')).toBe(
      'Everything saved for martonpaulo/tabelo was removed from this browser. Other repositories are untouched.',
    )
  })

  it('says nothing was removed when the browser refused', () => {
    expect(
      describeClear(
        { ok: false, reason: 'unavailable', message: 'This browser is not letting the page save anything.' },
        'martonpaulo/tabelo',
      ),
    ).toBe(
      'This browser is not letting the page save anything. Nothing saved for martonpaulo/tabelo could be removed.',
    )
  })
})

describe('describeSaveProblem', () => {
  it('says nothing at all when the copy was saved', () => {
    expect(describeSaveProblem({ ok: true })).toBeNull()
  })

  it('names the cost of a copy that was not saved, which lands on the next visit', () => {
    expect(
      describeSaveProblem({
        ok: false,
        reason: 'quota',
        message: 'This browser\u2019s storage is full.',
      }),
    ).toBe(
      'This browser\u2019s storage is full. This graph was not saved, so opening it again will read from GitHub.',
    )
  })
})

describe('describeShare', () => {
  it('says what a copied link does for whoever receives it', () => {
    expect(describeShare({ kind: 'copied', url: 'https://example.test/#g=x' })).toBe(
      'Link copied. It draws this graph without spending anyone\u2019s GitHub budget.',
    )
  })

  it('names both numbers when the graph is too large, and says nothing was shortened', () => {
    expect(describeShare({ kind: 'too-large', chars: 41234, limit: 32000 })).toBe(
      'This graph needs 41,234 characters, past the 32,000 a link can carry. Nothing was shortened.',
    )
  })

  it('states plainly when the browser cannot build one', () => {
    expect(describeShare({ kind: 'unsupported' })).toBe('This browser cannot build a shared link.')
  })
})

describe('graphBounds', () => {
  function dataFrom(issues: unknown, blockedBy: unknown): RepositoryGraphData {
    const blockers = new Map(
      Object.entries(blockedBy as Record<string, IssuePayload[]>).map(([number, list]) => [
        Number(number),
        list,
      ]),
    )
    return {
      issues: issues as IssuePayload[],
      blockers,
      complete: true,
      unresolved: [],
      rateLimited: false,
      rateLimitReset: null,
      requestCount: 1 + blockers.size,
      rateLimit: null,
      includedClosed: true,
    }
  }

  it('encloses every card and every group frame of a captured graph', async () => {
    const graph = await buildGraph(dataFrom(arbaroIssues, arbaroBlockedBy), {
      owner: 'martonpaulo',
      repo: 'arbaro',
    })
    const bounds = graphBounds(graph)

    expect(graph.nodes.length).toBeGreaterThan(0)
    expect(graph.groups.length).toBeGreaterThan(0)
    for (const node of graph.nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(bounds.left)
      expect(node.position.y).toBeGreaterThanOrEqual(bounds.top)
      expect(node.position.x + NODE_WIDTH).toBeLessThanOrEqual(bounds.right)
      expect(node.position.y + node.height).toBeLessThanOrEqual(bounds.bottom)
    }
    for (const group of graph.groups) {
      expect(group.position.x).toBeGreaterThanOrEqual(bounds.left)
      expect(group.position.y).toBeGreaterThanOrEqual(bounds.top)
      expect(group.position.x + group.width).toBeLessThanOrEqual(bounds.right)
      expect(group.position.y + group.height).toBeLessThanOrEqual(bounds.bottom)
    }
    expect(bounds.width).toBe(bounds.right - bounds.left)
    expect(bounds.height).toBe(bounds.bottom - bounds.top)
  })

  it('touches each edge of the box it reports', async () => {
    const graph = await buildGraph(dataFrom(arbaroIssues, arbaroBlockedBy), {
      owner: 'martonpaulo',
      repo: 'arbaro',
    })
    const bounds = graphBounds(graph)
    const boxes = [
      ...graph.nodes.map((node) => ({
        left: node.position.x,
        top: node.position.y,
        right: node.position.x + NODE_WIDTH,
        bottom: node.position.y + node.height,
      })),
      ...graph.groups.map((group) => ({
        left: group.position.x,
        top: group.position.y,
        right: group.position.x + group.width,
        bottom: group.position.y + group.height,
      })),
    ]
    expect(Math.min(...boxes.map((box) => box.left))).toBe(bounds.left)
    expect(Math.min(...boxes.map((box) => box.top))).toBe(bounds.top)
    expect(Math.max(...boxes.map((box) => box.right))).toBe(bounds.right)
    expect(Math.max(...boxes.map((box) => box.bottom))).toBe(bounds.bottom)
  })

  it('reports an empty box for a graph with nothing drawn', () => {
    const bounds = graphBounds({
      nodes: [],
      edges: [],
      groups: [],
      identity: 'acme/app',
      complete: true,
      unresolved: [],
      rateLimited: false,
      rateLimitReset: null,
      requestCount: 0,
    })
    expect(Number.isFinite(bounds.width)).toBe(false)
  })
})

/**
 * The two places a rate-limit figure reaches the reader. Both have to follow whether a token is
 * set, because quoting 60 to a viewer who supplied one understates what they can spend.
 */
describe('what the reader is told about the budget', () => {
  const target = { owner: 'acme', repo: 'app' }

  it('quotes the unauthenticated ceiling when GitHub’s numbers are unavailable', () => {
    expect(budgetParts(null, false).main).toBe('60/hour')
    expect(budgetParts(null, true).main).toBe('5000/hour')
  })

  it('prefers GitHub’s own numbers over either ceiling', () => {
    const status = { limit: 5000, remaining: 4987, reset: null }
    expect(budgetParts(status, true).main).toBe('4987/5000 left')
    expect(budgetParts(status, false).main).toBe('4987/5000 left')
  })

  it('offers a token when the limit is hit without one, and does not when it is hit with one', () => {
    const failure = { kind: 'rate-limited', reset: null } as const

    expect(failureText(target, failure, false).body).toContain('Adding a token')
    expect(failureText(target, failure, true).body).not.toContain('Adding a token')
    expect(failureText(target, failure, true).body).not.toContain('Unauthenticated')
  })

  it('says a rejected token is the thing to fix', () => {
    const text = failureText(target, { kind: 'bad-credentials' }, true)
    expect(text.title).toContain('token')
    expect(text.body).toContain('remove it')
  })

  it('reports an unexpected status once, rather than as its own body', () => {
    const text = failureText(
      target,
      { kind: 'unexpected', status: 500, message: 'GitHub returned error 500' },
      false,
    )

    expect(text.title).toBe('GitHub returned error 500')
    expect(text.body).not.toBe(text.title)
    expect(text.body).not.toContain('500')
    expect(text.body).toContain('Try again')
  })

  /**
   * A layout failure is not a request failure: GitHub already answered. Reporting it as one sent
   * the reader to check the connection that had just worked.
   */
  it('blames the drawing, not GitHub, when the layout is what failed', () => {
    const text = failureText(target, { kind: 'layout', message: 'the worker stopped.' }, false)

    expect(text.title).not.toContain('GitHub')
    expect(text.body).toContain('were read')
    expect(text.body).toContain('the worker stopped')
    // One period, not the two that carrying the message's own would produce.
    expect(text.body).not.toContain('stopped..')
  })

  it('keeps every top-level failure’s guidance distinct', () => {
    const bodies = [
      failureText(target, { kind: 'bad-credentials' }, true),
      failureText(target, { kind: 'rate-limited', reset: null }, false),
      failureText(target, { kind: 'unexpected', status: 500, message: 'GitHub returned error 500' }, false),
      failureText(target, { kind: 'not-found' }, false),
      failureText(target, { kind: 'network', message: 'Failed to fetch' }, false),
      failureText(target, { kind: 'layout', message: 'the worker stopped' }, false),
    ].map((text) => `${text.title}. ${text.body}`)

    expect(new Set(bodies).size).toBe(bodies.length)
  })
})

/**
 * The loader records why each issue's blockers could not be read. Showing the first reason for all
 * of them told the reader that a rate limit caused a 404.
 */
describe('describeUnresolved', () => {
  it('keeps one reason per issue when the causes differ', () => {
    const text = describeUnresolved([
      { number: 1, reason: 'Failed to fetch' },
      { number: 2, reason: 'dependencies were not found' },
      { number: 3, reason: 'GitHub returned error 500' },
    ])

    expect(text).toBe(
      'Some blocker data is missing: #1 — Failed to fetch; ' +
        '#2 — dependencies were not found; #3 — GitHub returned error 500.',
    )
  })

  it('groups issues that failed for the same reason', () => {
    const text = describeUnresolved([
      { number: 3, reason: 'rate limit reached' },
      { number: 9, reason: 'GitHub returned error 500' },
      { number: 7, reason: 'rate limit reached' },
    ])

    expect(text).toBe(
      'Some blocker data is missing: #3, #7 — rate limit reached; #9 — GitHub returned error 500.',
    )
  })

  it('ends the sentence once, whatever punctuation the reason arrived with', () => {
    const text = describeUnresolved([{ number: 4, reason: 'The request could not be sent.' }])

    expect(text).toBe('Some blocker data is missing: #4 — The request could not be sent.')
  })

  it('says so plainly when the loader recorded no reason at all', () => {
    expect(describeUnresolved([])).toBe('Some blocker data is missing, and GitHub did not say why.')
  })
})

describe('the dependencies as text', () => {
  it('renders one row per drawn edge, both ends named', async () => {
    const graph = await buildGraph(
      {
        issues: arbaroIssues as IssuePayload[],
        blockers: new Map(
          Object.entries(arbaroBlockedBy as Record<string, IssuePayload[]>).map(
            ([number, list]) => [Number(number), list],
          ),
        ),
        complete: true,
        unresolved: [],
        rateLimited: false,
        rateLimitReset: null,
        requestCount: 1,
        rateLimit: null,
        includedClosed: true,
      },
      { owner: 'martonpaulo', repo: 'arbaro' },
    )

    const rows = dependencyRows(graph)
    const html = renderToStaticMarkup(createElement(DependencyTable, { rows }))

    // Every blocking edge the canvas draws is reachable without tracing it. Hierarchy edges are
    // deliberately absent: containment is not a blocking relationship.
    const drawn = graph.edges.filter((edge) => edge.kind === 'dependency')
    expect(rows).toHaveLength(drawn.length)
    for (const edge of drawn) {
      const blocker = graph.nodes.find((node) => node.id === edge.source)!
      const dependent = graph.nodes.find((node) => node.id === edge.target)!
      expect(
        html,
        edge.id,
      ).toContain(
        `<span class="deps__ref">${issueRef(blocker)}</span> <span class="deps__title">`,
      )
      expect(html, edge.id).toContain(
        `<span class="deps__ref">${issueRef(dependent)}</span> <span class="deps__title">`,
      )
    }

    // The direction an arrowhead carries, written down.
    expect(html).toContain(DIRECTION_LEGEND)
    expect(html).toContain('<th scope="col">Blocker</th>')
    expect(html).toContain('<th scope="col">Blocks</th>')
  })
})

describe('blockerStateText', () => {
  const node = (over: Partial<GraphNode>): GraphNode => ({
    id: 'other/lib#9',
    number: 9,
    title: 'A blocker',
    url: 'https://github.com/other/lib/issues/9',
    repo: 'other/lib',
    state: null,
    open: true,
    subIssues: null,
    external: true,
    repoLabel: 'other/lib',
    labels: [],
    allLabels: [],
    titleLines: 1,
    height: 100,
    position: { x: 0, y: 0 },
    ...over,
  })

  it('says whether an external blocker is finished, which its repository never did', () => {
    // The column exists to separate a blocker still in the way from one that is not, and naming
    // the repository instead answered neither.
    expect(blockerStateText(node({ open: false }))).toBe('closed')
    expect(blockerStateText(node({ open: true }))).toBe('open')
  })

  it('prefers the local workflow state where the repository shares that convention', () => {
    expect(
      blockerStateText(node({ state: 'blocked', open: true, external: false })),
    ).toBe('blocked')
    expect(
      blockerStateText(node({ state: 'not-planned', open: false, external: false })),
    ).toBe('not planned')
  })
})

/**
 * The top chrome is a geometry check without a browser: what keeps the identity and the tools from
 * overlapping is that they are siblings in one flow container, not two panels pinned to opposite
 * corners with an offset large enough for today's font and today's repository name. These assert
 * that structure and the declarations it rests on, so reintroducing the pinned pair fails here
 * rather than at 320 CSS pixels in somebody's hand.
 */
describe('what a dimmed set is stored under', () => {
  it('keeps the key the rename to dimming inherited, so a saved set survives the new copy', () => {
    // Renaming the control renamed nothing on disk: every reader who dimmed cards before the
    // rename still finds them dimmed after it.
    expect(dimmedKey('owner/app')).toBe('issue-graph:hidden:owner/app')
  })
})

describe('the selection actions', () => {
  function bar(props: { canDim: boolean; canRestore: boolean }): string {
    return renderToStaticMarkup(
      createElement(
        ReactFlowProvider,
        null,
        createElement(SelectionBar, {
          selectedCount: 2,
          onDimSelected: () => {},
          onRestoreSelected: () => {},
          onClearSelection: () => {},
          ...props,
        }),
      ),
    )
  }

  it('names both actions after the emphasis they change, not after removal', () => {
    const html = bar({ canDim: true, canRestore: true })

    expect(html).toContain('aria-label="Dim the selected issues"')
    expect(html).toContain('data-tip="Dim the selected issues \u00b7 D"')
    expect(html).toContain('aria-label="Restore the selected issues"')
    expect(html).toContain('data-tip="Restore the selected issues \u00b7 R"')
    expect(html).not.toMatch(/aria-label="(Hide|Show) /)
  })

  it('offers each action only where it would change something', () => {
    expect(bar({ canDim: true, canRestore: false })).not.toContain('Restore the selected')
    expect(bar({ canDim: false, canRestore: true })).not.toContain('Dim the selected')
  })

  it('says nothing at all when nothing is selected', () => {
    const html = renderToStaticMarkup(
      createElement(
        ReactFlowProvider,
        null,
        createElement(SelectionBar, {
          selectedCount: 0,
          canDim: false,
          canRestore: false,
          onDimSelected: () => {},
          onRestoreSelected: () => {},
          onClearSelection: () => {},
        }),
      ),
    )
    expect(html).toBe('')
  })
})

describe('top chrome layout', () => {
  const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

  /** The declarations of the first rule with exactly this selector list. */
  function ruleFor(selector: string): string {
    const start = styles.indexOf(`\n${selector} {`) + 1
    expect(start, `no rule for ${selector}`).toBeGreaterThan(0)
    return styles.slice(start, styles.indexOf('}', start))
  }

  const longestSlug = `${'o'.repeat(39)}/${'r'.repeat(100)}`

  /** The toolbar needs a graph to offer a dependency list from; the geometry does not care. */
  const emptyGraph: IssueGraph = {
    nodes: [],
    edges: [],
    groups: [],
    identity: 'acme/app',
    complete: true,
    unresolved: [],
    rateLimited: false,
    rateLimitReset: null,
    requestCount: 0,
  }

  function chrome(slug: string) {
    return renderToStaticMarkup(
      createElement(TopChrome, {
        identity: {
          slug,
          nodeCount: 12,
          dependentCount: 5,
          blockingCount: 4,
          onOpenExternal: () => {},
        },
        tools: {
          graph: emptyGraph,
          labelCounts: [{ name: 'type: bug', count: 3 }],
          highlight: new Set<string>(),
          onToggleHighlight: () => {},
          onClearHighlight: () => {},
          onFitView: () => {},
          onShare: () => {},
          sharing: false,
          onAskAgain: () => {},
        },
      }),
    )
  }

  it('puts both bars in one panel, in order, so neither can be positioned over the other', () => {
    const html = chrome('martonpaulo/issues-graph')

    // One panel: two would be independently positioned again, which is the bug.
    expect(html.match(/react-flow__panel/g)).toHaveLength(1)
    expect(html).toContain('react-flow__panel topbar top left')
    expect(html.indexOf('bar bar--identity')).toBeLessThan(html.indexOf('bar bar--tools'))
  })

  it('keeps the whole slug in the accessible name and in a hint however long the name is', () => {
    const html = chrome(longestSlug)

    expect(html).toContain(`<span class="bar__slugtext">${longestSlug}</span>`)
    expect(html).toContain(`data-tip="${longestSlug}"`)
  })

  it('declares a strip that wraps, shrinks and lets the canvas be dragged through it', () => {
    const topbar = ruleFor('.react-flow__panel.topbar')
    expect(topbar).toContain('right: 0')
    expect(topbar).toContain('flex-wrap: wrap')
    expect(topbar).toContain('pointer-events: none')
    expect(ruleFor('.topbar > .bar')).toContain('pointer-events: auto')

    const bar = ruleFor('.bar')
    expect(bar).toContain('flex-wrap: wrap')
    expect(bar).toContain('min-width: 0')
    expect(bar).toContain('max-width: 100%')

    // Only the slug text is clipped, so no focus outline is drawn inside a clipped box.
    expect(ruleFor('.bar__slugtext')).toContain('text-overflow: ellipsis')
    for (const rule of styles.split('}')) {
      if (!/\.(bar|topbar)\b/.test(rule) || /__slugtext/.test(rule)) continue
      expect(rule, rule).not.toContain('overflow: hidden')
    }
  })

  it('keeps the full-slug hint inside the window and lets an unbroken name wrap', () => {
    const hint = ruleFor('.react-flow__panel .bar__slug[data-tip]::after')

    // A repository name has no space to break at, so the hint must break mid-word...
    expect(hint).toContain('overflow-wrap: anywhere')
    // ...and is measured against the identity bar, which the window already bounds.
    expect(hint).toContain('left: 0')
    expect(hint).toContain('right: auto')
    expect(hint).toContain('transform: none')
    expect(hint).toContain('max-width: 100%')
    // Without this the box is the bar's width *plus* its own padding, which leaves the window.
    expect(hint).toContain('box-sizing: border-box')

    expect(ruleFor('.bar--identity')).toContain('position: relative')
    // The button opts out of being the hint's containing block, so the bar becomes it.
    expect(styles).toMatch(/\.bar__slug \{[^}]*position: static/)

    // The panel-side alignment rule matches this hint too and sets the same three properties at
    // the same weight, so only source order decides which of them wins.
    expect(styles.indexOf('.react-flow__panel .bar__slug[data-tip]::after')).toBeGreaterThan(
      styles.indexOf('.react-flow__panel.left [data-tip]::after'),
    )
  })

  it('positions neither bar with a fixed offset that a longer name or larger text invalidates', () => {
    for (const rule of styles.split('}')) {
      if (!/\.bar--tools|\.bar--identity/.test(rule)) continue
      expect(rule, rule).not.toMatch(/(^|[^-\w])top:/)
    }
  })
})

describe('what a key press asks of the canvas', () => {
  const free = { captured: false, onControl: false }
  const onControl = { captured: false, onControl: true }

  function press(
    key: string,
    modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
  ) {
    return { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers }
  }

  it('keeps the shortcuts the canvas has always had', () => {
    expect(canvasShortcut(press('Escape'), free, 0)).toBe('clear')
    expect(canvasShortcut(press('a', { metaKey: true }), free, 0)).toBe('select-all')
    expect(canvasShortcut(press('A', { shiftKey: true }), free, 0)).toBe('select-all')
    expect(canvasShortcut(press('f'), free, 3)).toBe('fit')
    expect(canvasShortcut(press('D'), free, 3)).toBe('dim')
    expect(canvasShortcut(press('r'), free, 3)).toBe('restore')
    expect(canvasShortcut(press('Enter'), free, 1)).toBe('open')
  })

  it('stands down on Enter while a control has the focus, so one press has one outcome', () => {
    expect(canvasShortcut(press('Enter'), onControl, 1)).toBeNull()
  })

  /* The other four share no key with an activation: a button ignores D, so the canvas may have it
     even while that button is focused, and taking it away would make the bar's own hints wrong. */
  it('still answers the keys a focused control does not act on', () => {
    expect(canvasShortcut(press('f'), onControl, 1)).toBe('fit')
    expect(canvasShortcut(press('d'), onControl, 1)).toBe('dim')
    expect(canvasShortcut(press('r'), onControl, 1)).toBe('restore')
    expect(canvasShortcut(press('Escape'), onControl, 1)).toBe('clear')
  })

  it('says nothing at all while a field or a dialog is waiting on an answer', () => {
    const captured = { captured: true, onControl: false }
    for (const key of ['Escape', 'a', 'f', 'd', 'r', 'Enter']) {
      expect(canvasShortcut(press(key), captured, 1), key).toBeNull()
    }
  })

  it('opens only when the selection is exactly one issue', () => {
    expect(canvasShortcut(press('Enter'), free, 0)).toBeNull()
    expect(canvasShortcut(press('Enter'), free, 2)).toBeNull()
  })

  it('leaves the browser its own chords', () => {
    expect(canvasShortcut(press('f', { metaKey: true }), free, 1)).toBeNull()
    expect(canvasShortcut(press('r', { ctrlKey: true }), free, 1)).toBeNull()
    expect(canvasShortcut(press('d', { altKey: true }), free, 1)).toBeNull()
  })
})

describe('where the focus ring is allowed to show', () => {
  const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

  /**
   * The wrappers stopped being tab stops in the markup rather than in the stylesheet: React Flow
   * is told not to make them focusable at all. A rule that hides their ring would only be there to
   * hide a stop that still exists, which is the fault this replaced.
   */
  it('suppresses no ring on a React Flow wrapper', () => {
    for (const rule of styles.split('}')) {
      if (!/\.react-flow(__(pane|node|renderer))?:focus/.test(rule)) continue
      expect(rule, rule).not.toMatch(/outline:\s*none/)
    }
  })

  it('shows the card icons whenever one of them takes the focus', () => {
    expect(styles).toMatch(/\.card__actions:focus-within[^{]*\{[^}]*opacity: 1/)
  })
})
