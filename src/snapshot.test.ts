import { describe, expect, it } from 'vitest'

import type { IssuePayload, RepositoryGraphData } from './github'
import { buildGraph } from './graph'
import { buildSnapshotUrl, readSnapshot, SNAPSHOT_URL_LIMIT } from './snapshot'
import tabeloBlockedBy from './__fixtures__/tabelo.blocked-by.json'
import tabeloIssues from './__fixtures__/tabelo.issues.json'
import arbaroBlockedBy from './__fixtures__/arbaro.blocked-by.json'
import arbaroIssues from './__fixtures__/arbaro.issues.json'

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
const arbaro = graph(arbaroIssues, arbaroBlockedBy)
const SAVED_AT = new Date('2026-08-31T10:00:00Z')

function fragmentOf(url: string): string {
  return url.slice(url.indexOf('#'))
}

/**
 * Encodes an arbitrary object the way the module does, so a test can post a structurally
 * malformed payload that is nonetheless perfectly well-formed base64 and DEFLATE. That is the
 * shape a hand-written fragment actually takes, and the shape a shallow check waves through.
 */
async function fragmentFor(payload: unknown): Promise<string> {
  const stream = new Blob([JSON.stringify(payload)])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `#g=${encoded}`
}

/** One issue carrying every field the graph and the cards read off it. */
function validIssue() {
  return {
    number: 12,
    title: 'A blocked issue',
    state: 'open',
    state_reason: null,
    html_url: 'https://github.com/a/b/issues/12',
    repository_url: 'https://api.github.com/repos/a/b',
    labels: [{ name: 'type: bug', color: '7B3FA0' }],
  }
}

/** The smallest payload this module accepts, as the base for one-field corruptions. */
function wholePayload(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    slug: 'a/b',
    shown: false,
    graph: {
      version: 1,
      savedAt: SAVED_AT.getTime(),
      issues: [],
      blockers: [],
      complete: true,
      unresolved: [],
      includedClosed: false,
      requestCount: 3,
      ...overrides,
    },
  }
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
      'martonpaulo/arbaro',
      graph(arbaroIssues, arbaroBlockedBy, { includedClosed: true }),
    )
    const read = await readSnapshot(fragmentOf(link.url), 'martonpaulo/arbaro')

    expect(read.kind).toBe('snapshot')
    if (read.kind !== 'snapshot') return
    expect(read.view.data.includedClosed).toBe(true)
    expect(read.view.showClosed).toBe(true)
    expect(read.view.data.issues).toEqual(arbaro.issues)
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
    const link = await share('martonpaulo/arbaro', arbaro)
    const read = await readSnapshot(fragmentOf(link.url), 'martonpaulo/arbaro')

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

  it('reproduces the graph it was made from when a rename redirected the read', async () => {
    // The regression this guards: the sender read `acme/old-app`, GitHub answered under the
    // current name, and a link built from the address the sender was on would arrive bound to
    // `acme/old-app`. The recipient does not trust the payload to name its own repository, so it
    // would fall back to that address, find no issue belonging to it, and draw every card as
    // external with no edge between them.
    const blocked = {
      number: 5,
      title: 'Waits for one thing',
      state: 'open',
      state_reason: null,
      html_url: 'https://github.com/acme/app/issues/5',
      repository_url: 'https://api.github.com/repos/acme/app',
      labels: [],
      issue_dependencies_summary: {
        blocked_by: 1,
        total_blocked_by: 1,
        blocking: 0,
        total_blocking: 0,
      },
    }
    const blocker = { ...blocked, number: 2, title: 'Lands first' }
    const data: RepositoryGraphData = {
      issues: [blocked, blocker],
      blockers: new Map([[5, [blocker]]]),
      complete: true,
      unresolved: [],
      rateLimited: false,
      rateLimitReset: null,
      requestCount: 2,
      rateLimit: null,
      includedClosed: false,
    }

    // What the sender sees: a trusted read reached through the old alias.
    const drawn = await buildGraph(data, { owner: 'acme', repo: 'old-app' }, { trustedIdentity: true })
    expect(drawn.edges).toHaveLength(1)

    // The link is bound to the repository the cards belong to, not to the address in the sender's
    // address bar, and its path names the same repository its payload does.
    const link = await share(drawn.identity, data, false)
    expect(link.url).toContain('dependencies/acme/app#')

    // What the recipient gets, at the address that link puts them on, trusting nothing in it.
    const read = await readSnapshot(fragmentOf(link.url), drawn.identity)
    expect(read.kind).toBe('snapshot')
    if (read.kind !== 'snapshot') return

    const redrawn = await buildGraph(read.view.data, { owner: 'acme', repo: 'app' })
    expect(redrawn.edges.map((edge) => edge.id)).toEqual(drawn.edges.map((edge) => edge.id))
    expect(redrawn.nodes.every((node) => !node.external)).toBe(true)

    // And what binding the link to the sender's address does instead, which is why it does not:
    // the recipient falls back to `acme/old-app`, no issue in the payload belongs to it, and the
    // graph arrives as a set of foreign cards with nothing joining them.
    const misbound = await share('acme/old-app', data, false)
    const readOld = await readSnapshot(fragmentOf(misbound.url), 'acme/old-app')
    expect(readOld.kind).toBe('snapshot')
    if (readOld.kind !== 'snapshot') return

    const broken = await buildGraph(readOld.view.data, { owner: 'acme', repo: 'old-app' })
    expect(broken.edges).toHaveLength(0)
    expect(broken.nodes.every((node) => node.external)).toBe(true)
  })

  it('opens a link whose slug differs from the page only in case', async () => {
    // Owner and repository are not case-sensitive on GitHub, so the sender's address bar and the
    // recipient's can spell one repository differently. That is not a different repository.
    const link = await share('martonpaulo/tabelo', tabelo)
    const read = await readSnapshot(fragmentOf(link.url), 'MartonPaulo/Tabelo')

    expect(read.kind).toBe('snapshot')
  })

  it('rejects a link whose payload names a different repository', async () => {
    const link = await share('martonpaulo/tabelo', tabelo)
    const read = await readSnapshot(fragmentOf(link.url), 'martonpaulo/issues-graph')

    expect(read).toEqual({
      kind: 'invalid',
      reason: 'This shared link holds martonpaulo/tabelo, not martonpaulo/issues-graph.',
    })
  })

  it('accepts the whole shape it defines', async () => {
    // The control for the corruption cases below: without it, a validator that rejected
    // everything would pass all of them.
    const read = await readSnapshot(await fragmentFor(wholePayload()), 'a/b')
    expect(read.kind).toBe('snapshot')
  })

  it.each([
    ['complete', 'complete'],
    ['unresolved', 'unresolved'],
    ['includedClosed', 'includedClosed'],
    ['savedAt', 'savedAt'],
    ['requestCount', 'requestCount'],
    ['issues', 'issues'],
    ['blockers', 'blockers'],
  ])(
    'rejects a structurally valid payload missing graph.%s',
    async (_name, field) => {
      // Well-formed base64 and DEFLATE, parseable JSON, one field short. `complete` is the one
      // that used to reach GraphStatus as undefined and crash it on unresolved.map.
      const payload = wholePayload()
      delete (payload.graph as Record<string, unknown>)[field]

      const read = await readSnapshot(await fragmentFor(payload), 'a/b')
      expect(read).toEqual({
        kind: 'invalid',
        reason: 'This shared link is damaged or incomplete.',
      })
    },
  )

  it('rejects a timestamp that would render as NaN rather than an age', async () => {
    // The last two are finite numbers that Date cannot represent: the ECMAScript time range is
    // ±8.64e15 ms, so finiteness alone still lets an Invalid Date reach the banner.
    const bad = [
      'yesterday',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      1e20,
      8_640_000_000_000_001,
      -8_640_000_000_000_001,
    ]

    for (const savedAt of bad) {
      const read = await readSnapshot(await fragmentFor(wholePayload({ savedAt })), 'a/b')
      expect(read.kind, String(savedAt)).toBe('invalid')
    }
  })

  it('accepts the extremes of the range Date can represent', async () => {
    // The other side of the boundary above, so the check cannot be tightened into rejecting
    // every large timestamp and still pass.
    for (const savedAt of [0, 8_640_000_000_000_000, -8_640_000_000_000_000]) {
      const read = await readSnapshot(await fragmentFor(wholePayload({ savedAt })), 'a/b')
      expect(read.kind, String(savedAt)).toBe('snapshot')
      if (read.kind !== 'snapshot') continue
      expect(Number.isNaN(read.view.capturedAt.getTime())).toBe(false)
    }
  })

  it('rejects issues and blockers that are not the shape the cards read', async () => {
    const cases: Record<string, unknown>[] = [
      { issues: [{ number: 1 }] },
      { issues: [{ ...validIssue(), labels: [{ name: 'type: bug' }] }] },
      { issues: [{ ...validIssue(), number: 'twelve' }] },
      { blockers: [[1]] },
      { blockers: [['one', []]] },
      { blockers: [[1, [{ number: 2 }]]] },
      { unresolved: [{ number: 1 }] },
    ]

    for (const overrides of cases) {
      const read = await readSnapshot(await fragmentFor(wholePayload(overrides)), 'a/b')
      expect(read, JSON.stringify(overrides)).toEqual({
        kind: 'invalid',
        reason: 'This shared link is damaged or incomplete.',
      })
    }
  })

  it('rejects a drawing that claims closed blockers its read never covered', async () => {
    const read = await readSnapshot(
      await fragmentFor({ ...wholePayload(), shown: true }),
      'a/b',
    )
    expect(read).toEqual({ kind: 'invalid', reason: 'This shared link contradicts itself.' })
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
