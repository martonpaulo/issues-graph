import { describe, expect, it } from 'vitest'

import { parseRoute, parseTargetInput, pathForTarget, segmentsOf, slugOf } from './route'

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
