import { describe, expect, it } from 'vitest'

import {
  parseRoute,
  parseTargetInput,
  pathForTarget,
  segmentsOf,
  slugOf,
  titleForRoute,
} from './route'

const BASE = '/issues-graph/'

describe('parseRoute', () => {
  it('reads owner and repository from the canonical path', () => {
    expect(parseRoute(`${BASE}dependencies/acme/app`, BASE)).toEqual({
      kind: 'graph',
      target: { owner: 'acme', repo: 'app' },
    })
  })

  it('rejects a bare repository, because the owner is never assumed', () => {
    expect(parseRoute(`${BASE}dependencies/tabelo`, BASE)).toEqual({
      kind: 'invalid',
      reason: 'A dependency URL names an owner and a repository.',
    })
  })

  it('treats the site root and a bare /dependencies as the index', () => {
    expect(parseRoute(BASE, BASE).kind).toBe('index')
    expect(parseRoute(`${BASE}dependencies`, BASE).kind).toBe('index')
  })

  it('rejects a path with more segments than owner and repository', () => {
    expect(parseRoute(`${BASE}dependencies/a/b/c`, BASE).kind).toBe('invalid')
  })

  it('rejects names outside GitHub character set before they reach a request URL', () => {
    for (const bad of ['..', 'a/b', 'has space', '-leading', '~']) {
      expect(parseRoute(`${BASE}dependencies/acme/${encodeURIComponent(bad)}`, BASE).kind).toBe(
        'invalid',
      )
    }
  })

  it('tolerates a trailing slash', () => {
    expect(parseRoute(`${BASE}dependencies/acme/app/`, BASE)).toEqual({
      kind: 'graph',
      target: { owner: 'acme', repo: 'app' },
    })
  })

  it('rejects an unknown top-level path', () => {
    expect(parseRoute(`${BASE}something-else`, BASE).kind).toBe('invalid')
  })

  it('works when the base prefix is missing from the pathname', () => {
    expect(parseRoute('/dependencies/acme/app', BASE)).toEqual({
      kind: 'graph',
      target: { owner: 'acme', repo: 'app' },
    })
  })

  it('reports a malformed escape as an invalid route instead of throwing', () => {
    for (const bad of ['%', '%E0%A4%A', '%z', 'a%2']) {
      expect(parseRoute(`${BASE}dependencies/acme/${bad}`, BASE)).toEqual({
        kind: 'invalid',
        reason: 'This URL is malformed. Enter a repository as owner/repo.',
      })
    }
  })

  it('reports a malformed escape wherever it sits in the path', () => {
    expect(parseRoute(`${BASE}%/acme/app`, BASE).kind).toBe('invalid')
    expect(parseRoute(`${BASE}dependencies/%E0%A4%A/app/`, BASE).kind).toBe('invalid')
    expect(parseRoute('/dependencies/acme/%', BASE).kind).toBe('invalid')
  })

  it('still reads a name written with valid percent encoding', () => {
    expect(parseRoute(`${BASE}dependencies/%61cme/a%70p`, BASE)).toEqual({
      kind: 'graph',
      target: { owner: 'acme', repo: 'app' },
    })
  })
})

describe('segmentsOf', () => {
  it('drops the base and empty segments', () => {
    expect(segmentsOf(`${BASE}dependencies//acme/app/`, BASE)).toEqual([
      'dependencies',
      'acme',
      'app',
    ])
  })

  it('decodes valid escapes', () => {
    expect(segmentsOf(`${BASE}dependencies/%61cme/my%2Erepo`, BASE)).toEqual([
      'dependencies',
      'acme',
      'my.repo',
    ])
  })

  it('returns null rather than throwing on a malformed escape', () => {
    for (const bad of ['%', '%E0%A4%A', '%z', 'a%2']) {
      expect(segmentsOf(`${BASE}dependencies/acme/${bad}`, BASE)).toBeNull()
      expect(segmentsOf(`/dependencies/acme/${bad}/`, BASE)).toBeNull()
    }
  })
})

describe('pathForTarget', () => {
  it('writes owner and repository', () => {
    expect(pathForTarget({ owner: 'acme', repo: 'app' }, BASE)).toBe(
      '/issues-graph/dependencies/acme/app',
    )
  })

  it('round-trips through parseRoute', () => {
    const target = { owner: 'acme', repo: 'app' }
    expect(parseRoute(pathForTarget(target, BASE), BASE)).toEqual({ kind: 'graph', target })
  })
})

describe('slugOf', () => {
  it('joins the target the way GitHub writes it', () => {
    expect(slugOf({ owner: 'acme', repo: 'app' })).toBe('acme/app')
  })
})

describe('parseTargetInput', () => {
  it('accepts owner/repo and a pasted GitHub URL', () => {
    expect(parseTargetInput('acme/app')).toEqual({ owner: 'acme', repo: 'app' })
    expect(parseTargetInput('  acme/app ')).toEqual({ owner: 'acme', repo: 'app' })
    expect(parseTargetInput('https://github.com/acme/app/')).toEqual({ owner: 'acme', repo: 'app' })
  })

  it('rejects empty, malformed, and owner-less input', () => {
    expect(parseTargetInput('')).toBeNull()
    expect(parseTargetInput('a/b/c')).toBeNull()
    expect(parseTargetInput('bad name')).toBeNull()
    expect(parseTargetInput('tabelo')).toBeNull()
  })
})

describe('titleForRoute', () => {
  const titleAt = (pathname: string) => titleForRoute(parseRoute(pathname, BASE))

  it('names the product on the index', () => {
    expect(titleAt(BASE)).toBe('Issue dependencies')
  })

  it('leads with the repository on a graph route', () => {
    expect(titleAt(`${BASE}dependencies/acme/app`)).toBe('acme/app · Issue dependencies')
  })

  it('falls back to the index title without echoing a rejected path', () => {
    const title = titleAt(`${BASE}dependencies/acme/${encodeURIComponent('<img src=x>')}`)
    expect(title).toBe('Issue dependencies')
    expect(title).not.toContain('<')
  })

  it('changes across a navigation sequence, including going back', () => {
    // The history stack a viewer builds, then walks back through: App derives the route from
    // `pathname`, which Back and Forward update the same way an in-app link does.
    const visited = [
      BASE,
      `${BASE}dependencies/acme/app`,
      `${BASE}dependencies/other/repo`,
      `${BASE}nope`,
      `${BASE}dependencies/acme/app`,
    ]

    expect(visited.map(titleAt)).toEqual([
      'Issue dependencies',
      'acme/app · Issue dependencies',
      'other/repo · Issue dependencies',
      'Issue dependencies',
      'acme/app · Issue dependencies',
    ])
  })
})
