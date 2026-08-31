import { describe, expect, it } from 'vitest'

import type { IssuePayload, RepositoryGraphData } from './github'
import { buildSnapshotUrl, readSnapshot, SNAPSHOT_URL_LIMIT } from './snapshot'
import tabeloBlockedBy from './__fixtures__/tabelo.blocked-by.json'
import tabeloIssues from './__fixtures__/tabelo.issues.json'
import workflowsBlockedBy from './__fixtures__/agent-workflows.blocked-by.json'
import workflowsIssues from './__fixtures__/agent-workflows.issues.json'

const ORIGIN = 'https://martonpaulo.github.io'
const BASE = '/issues-graph/'

function blockersOf(raw: unknown): Map<number, IssuePayload[]> {
  return new Map(
    Object.entries(raw as Record<string, IssuePayload[]>).map(([number, list]) => [
      Number(number),
      list,
    ]),
  )
}

function graph(
  issues: unknown,
  blockedBy: unknown,
  overrides: Partial<RepositoryGraphData> = {},
): RepositoryGraphData {
  return {
    issues: issues as IssuePayload[],
    blockers: blockersOf(blockedBy),
    complete: true,
    unresolved: [],
    rateLimited: false,
    rateLimitReset: null,
    requestCount: 12,
    rateLimit: null,
    includedClosed: false,
    ...overrides,
  }
}

const tabelo = graph(tabeloIssues, tabeloBlockedBy)
const workflows = graph(workflowsIssues, workflowsBlockedBy)
const SAVED_AT = new Date('2026-08-31T10:00:00Z')

function fragmentOf(url: string): string {
  return url.slice(url.indexOf('#'))
}

async function share(
  slug: string,
  data: RepositoryGraphData,
  showClosed = data.includedClosed,
): Promise<Extract<Awaited<ReturnType<typeof buildSnapshotUrl>>, { kind: 'ready' }>> {
  const link = await buildSnapshotUrl(
    slug,
    { data, capturedAt: SAVED_AT, showClosed },
    ORIGIN,
    BASE,
  )
  if (link.kind !== 'ready') throw new Error(`expected a link, got ${link.kind}`)
  return link
}

describe('buildSnapshotUrl', () => {
  it('addresses the repository it was taken from', async () => {
    const link = await share('martonpaulo/tabelo', tabelo)
    expect(link.url.startsWith(`${ORIGIN}${BASE}dependencies/martonpaulo/tabelo#g=`)).toBe(true)
  })

  it('keeps a real repository well inside the length budget', async () => {
    // The fixture is 46 issues with 36 further blockers, which is what the budget was measured
    // against. A regression that inflates the payload shows up here before it reaches a viewer.
    const link = await share('martonpaulo/tabelo', tabelo)
    expect(link.url.length).toBeLessThan(SNAPSHOT_URL_LIMIT / 2)
  })

  it('declines rather than truncating when the payload outgrows the budget', async () => {
    // Titles of random-ish text so compression cannot collapse the bulk away.
    const bulky = graph(
      Array.from({ length: 4000 }, (_, index) => ({
        ...(tabelo.issues[index % tabelo.issues.length] as IssuePayload),
        number: 10_000 + index,
        title: `${index} ${Math.random().toString(36)} ${Math.random().toString(36)}`,
      })),
      {},
    )

    const link = await buildSnapshotUrl(
      'martonpaulo/tabelo',
      { data: bulky, capturedAt: SAVED_AT, showClosed: false },
      ORIGIN,
      BASE,
    )
    expect(link).toMatchObject({ kind: 'too-large', limit: SNAPSHOT_URL_LIMIT })
    if (link.kind === 'too-large') expect(link.chars).toBeGreaterThan(SNAPSHOT_URL_LIMIT)
  })
})

describe('readSnapshot', () => {
  it('round-trips a captured repository', async () => {
    const link = await share('martonpaulo/tabelo', tabelo)
    const read = await readSnapshot(fragmentOf(link.url), 'martonpaulo/tabelo')

    expect(read.kind).toBe('snapshot')
    if (read.kind !== 'snapshot') return
    expect(read.view.capturedAt.toISOString()).toBe(SAVED_AT.toISOString())
    expect(read.view.data.issues).toEqual(tabelo.issues)
    expect([...read.view.data.blockers]).toEqual([...tabelo.blockers])
    expect(read.view.data.includedClosed).toBe(false)
    expect(read.view.showClosed).toBe(false)
    expect(read.view.data.complete).toBe(true)
  })

  it('carries the coverage the read that produced it had', async () => {
    const link = await share(
      'martonpaulo/agent-workflows',
      graph(workflowsIssues, workflowsBlockedBy, { includedClosed: true }),
    )
    const read = await readSnapshot(fragmentOf(link.url), 'martonpaulo/agent-workflows')

    expect(read.kind).toBe('snapshot')
    if (read.kind !== 'snapshot') return
    expect(read.view.data.includedClosed).toBe(true)
    expect(read.view.showClosed).toBe(true)
    expect(read.view.data.issues).toEqual(workflows.issues)
  })

  it('sends the graph that was drawn, not the wider read behind it', async () => {
    // A saved copy that covered closed blockers may be opened without them: decideSavedCopyOpen
    // only refuses the reverse. Deriving the drawing from the coverage would hand the recipient
    // nodes and edges the sender was not looking at.
    const broad = graph(tabeloIssues, tabeloBlockedBy, { includedClosed: true })
    const link = await share('martonpaulo/tabelo', broad, false)
    const read = await readSnapshot(fragmentOf(link.url), 'martonpaulo/tabelo')

    expect(read.kind).toBe('snapshot')
    if (read.kind !== 'snapshot') return
    expect(read.view.showClosed).toBe(false)
    expect(read.view.data.includedClosed).toBe(true)
  })

  it('keeps a widened view widened when the sender was looking at one', async () => {
    const broad = graph(tabeloIssues, tabeloBlockedBy, { includedClosed: true })
    const link = await share('martonpaulo/tabelo', broad, true)
    const read = await readSnapshot(fragmentOf(link.url), 'martonpaulo/tabelo')

    expect(read.kind).toBe('snapshot')
    if (read.kind !== 'snapshot') return
    expect(read.view.showClosed).toBe(true)
  })

  it('reports no budget of its own, because the requests were spent when it was taken', async () => {
    const link = await share('martonpaulo/agent-workflows', workflows)
    const read = await readSnapshot(fragmentOf(link.url), 'martonpaulo/agent-workflows')

    expect(read.kind).toBe('snapshot')
    if (read.kind !== 'snapshot') return
    expect(read.view.data.rateLimited).toBe(false)
    expect(read.view.data.rateLimit).toBeNull()
    expect(read.view.data.rateLimitReset).toBeNull()
  })

  it('finds nothing in an absent, empty or unrelated fragment', async () => {
    expect(await readSnapshot('', 'a/b')).toEqual({ kind: 'none' })
    expect(await readSnapshot('#', 'a/b')).toEqual({ kind: 'none' })
    expect(await readSnapshot('#g=', 'a/b')).toEqual({ kind: 'none' })
    expect(await readSnapshot('#section-two', 'a/b')).toEqual({ kind: 'none' })
  })

  it('rejects a fragment that is not a snapshot at all', async () => {
    const read = await readSnapshot('#g=not-base64-at-all!!', 'a/b')
    expect(read).toEqual({ kind: 'invalid', reason: 'This shared link is damaged or incomplete.' })
  })

  it('rejects a truncated payload instead of drawing part of it', async () => {
    const link = await share('martonpaulo/tabelo', tabelo)
    const cut = fragmentOf(link.url).slice(0, -400)
    const read = await readSnapshot(cut, 'martonpaulo/tabelo')

    expect(read.kind).toBe('invalid')
  })

  it('rejects a link whose payload names a different repository', async () => {
    const link = await share('martonpaulo/tabelo', tabelo)
    const read = await readSnapshot(fragmentOf(link.url), 'martonpaulo/issues-graph')

    expect(read).toEqual({
      kind: 'invalid',
      reason: 'This shared link holds martonpaulo/tabelo, not martonpaulo/issues-graph.',
    })
  })

  it('rejects a payload from a format it does not know', async () => {
    // Encoded the same way the module does, so only the version differs.
    const bytes = await new Response(
      new Blob([
        new TextEncoder().encode(JSON.stringify({ v: 2, slug: 'a/b', graph: {}, shown: false })),
      ])
        .stream()
        .pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer()
    const encoded = btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')

    const read = await readSnapshot(`#g=${encoded}`, 'a/b')
    expect(read).toEqual({
      kind: 'invalid',
      reason: 'This shared link was made by a different version.',
    })
  })
})
