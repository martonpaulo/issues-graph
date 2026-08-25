import { describe, expect, it } from 'vitest'

import { DEFAULT_OWNER, parseRoute, parseTargetInput, pathForTarget, segmentsOf } from './route'

const BASE = '/agent-workflows/'

describe('parseRoute', () => {
  it('reads owner and repository from the canonical path', () => {
    expect(parseRoute(`${BASE}dependencies/acme/app`, BASE)).toEqual({
      kind: 'graph',
      target: { owner: 'acme', repo: 'app' },
    })
  })

  it('defaults the owner when only a repository is named', () => {
    expect(parseRoute(`${BASE}dependencies/tabelo`, BASE)).toEqual({
      kind: 'graph',
      target: { owner: DEFAULT_OWNER, repo: 'tabelo' },
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

  it('tolerates a trailing slash, which collapses to the single-segment form', () => {
    expect(parseRoute(`${BASE}dependencies/tabelo/`, BASE)).toEqual({
      kind: 'graph',
      target: { owner: DEFAULT_OWNER, repo: 'tabelo' },
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
})

describe('segmentsOf', () => {
  it('drops the base and empty segments', () => {
    expect(segmentsOf(`${BASE}dependencies//acme/app/`, BASE)).toEqual([
      'dependencies',
      'acme',
      'app',
    ])
  })
})

describe('pathForTarget', () => {
  it('always writes the owner, so a shared link never depends on the default', () => {
    expect(pathForTarget({ owner: 'acme', repo: 'app' }, BASE)).toBe(
      '/agent-workflows/dependencies/acme/app',
    )
  })

  it('round-trips through parseRoute', () => {
    const target = { owner: 'acme', repo: 'app' }
    expect(parseRoute(pathForTarget(target, BASE), BASE)).toEqual({ kind: 'graph', target })
  })
})

describe('parseTargetInput', () => {
  it('accepts owner/repo, a bare repo, and a pasted GitHub URL', () => {
    expect(parseTargetInput('acme/app')).toEqual({ owner: 'acme', repo: 'app' })
    expect(parseTargetInput('  tabelo ')).toEqual({ owner: DEFAULT_OWNER, repo: 'tabelo' })
    expect(parseTargetInput('https://github.com/acme/app/')).toEqual({ owner: 'acme', repo: 'app' })
  })

  it('rejects empty and malformed input', () => {
    expect(parseTargetInput('')).toBeNull()
    expect(parseTargetInput('a/b/c')).toBeNull()
    expect(parseTargetInput('bad name')).toBeNull()
  })
})
