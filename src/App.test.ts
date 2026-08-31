import { readFileSync } from 'node:fs'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { App } from './App'

/**
 * Installs the browser globals the router reads, for one pathname and fragment.
 *
 * The router touches `location`, `history` and `localStorage` during its first render, and the
 * node test environment has none of them.
 */
function atPath<T>(pathname: string, run: () => T): T {
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
      location: { pathname, search: '', hash: '' },
      history: { replaceState: () => {}, pushState: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  })

  try {
    return run()
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

describe('what each route costs to open', () => {
  it('draws the landing page without reaching the graph runtime', () => {
    const html = atPath('/', () => renderToStaticMarkup(createElement(App)))

    expect(html).toContain('Issue dependencies')
    expect(html).toContain('owner/repo')
    // React Flow renders this wrapper around every canvas, and nothing else in the page does.
    expect(html).not.toContain('react-flow')
  })

  it('keeps the shell on screen while the graph chunk is still arriving', () => {
    // `React.lazy` has not resolved during a synchronous render, so this is exactly what a reader
    // sees between entering a repository and the chunk landing.
    const html = atPath('/dependencies/acme/app', () => renderToStaticMarkup(createElement(App)))

    expect(html).toContain('Loading the graph')
    // The heading and the repository field never move, so the page continues rather than blanks.
    expect(html).toContain('Issue dependencies')
    expect(html).toContain('acme/app')
  })
})

describe('the lazy boundary itself', () => {
  /**
   * The split is a property of the import graph, not of one render: a single static import of the
   * graph runtime from either eager module folds React Flow back into the landing chunk, and the
   * page would still look correct while costing what it cost before.
   */
  it('keeps the graph runtime out of every module the landing page loads eagerly', () => {
    for (const module of ['src/App.tsx', 'src/Shell.tsx']) {
      const source = readFileSync(module, 'utf8')
      const staticImports = [...source.matchAll(/^import\s[^\n]*?from\s+'([^']+)'/gm)].map(
        (match) => match[1],
      )

      expect(staticImports, module).not.toContain('./GraphView')
      expect(staticImports, module).not.toContain('@xyflow/react')
    }

    expect(readFileSync('src/App.tsx', 'utf8')).toContain("import('./GraphView')")
  })
})
