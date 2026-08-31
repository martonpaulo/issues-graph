/**
 * A shared snapshot: the graph on screen, encoded into the URL that renders it.
 *
 *   /dependencies/:owner/:repo#g=<base64url( deflate-raw( JSON(SnapshotPayload) ) )>
 *
 * The payload lives in the fragment because a fragment is the one part of a URL browsers never
 * transmit. Someone's backlog therefore reaches neither GitHub Pages nor its logs, which is what
 * makes a hosted store unnecessary rather than merely avoidable.
 *
 * The recipient spends nothing: opening a snapshot issues no GitHub request at all, which is the
 * whole point of sending one rather than sending `/dependencies/owner/repo`.
 */

import { fromStored, isStoredGraph, toStored, type StoredGraph } from './cache'
import type { RepositoryGraphData } from './github'
import { canonicalSlug } from './route'

/** The fragment key. Short because every character of it is charged to the length budget. */
const KEY = 'g'

const FORMAT = 'deflate-raw'

interface SnapshotPayload {
  v: 1
  /**
   * The repository the snapshot was taken from, carried inside the payload as well as in the path
   * so a link whose two halves disagree is rejected rather than drawn against the wrong one.
   */
  slug: string
  graph: StoredGraph
  /**
   * The closed-blocker choice the graph was drawn with, which is not the same fact as the
   * coverage stored in `graph.includedClosed`. A read that covered closed blockers can be drawn
   * without them, and deriving the drawing from the coverage would hand the recipient nodes and
   * edges the sender was not looking at.
   */
  shown: boolean
}

/** A drawn graph, as the thing a link is made from and the thing a link produces. */
export interface SnapshotView {
  data: RepositoryGraphData
  /** When the GitHub read behind it happened, not when the link was built. */
  capturedAt: Date
  /** The closed-blocker choice it was drawn with. */
  showClosed: boolean
}

/**
 * The longest complete URL this viewer will produce.
 *
 * Roughly half of the smallest limit any current target browser imposes (Firefox, 65,536
 * characters) and about four times the largest captured fixture, which encodes to ~6,900
 * characters for 82 issue records. Past it the link stops being something that survives being
 * pasted into a message, so the viewer declines to build one instead of emitting a link that
 * arrives truncated and renders nothing.
 */
export const SNAPSHOT_URL_LIMIT = 32000

export type SnapshotLink =
  | { kind: 'ready'; url: string }
  | { kind: 'too-large'; chars: number; limit: number }
  | { kind: 'unsupported' }

export type SnapshotRead =
  | { kind: 'none' }
  | { kind: 'snapshot'; view: SnapshotView }
  | { kind: 'invalid'; reason: string }

/* Base64url, because `+`, `/` and `=` are all either reserved or escaped in a URL. */

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/*
 * CompressionStream is a platform API rather than a dependency, and `deflate-raw` drops the
 * gzip header the payload has no use for. Chrome 103+, Safari 16.4+, Firefox 113+, and Node,
 * which is the environment the suite runs in.
 * https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream
 */
function supported(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
}

async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream(FORMAT))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(FORMAT))
  return new Response(stream).text()
}

/**
 * Builds the shareable URL, or explains why it will not.
 *
 * `origin` and `base` are passed in rather than read from `window` so the format can be tested
 * without a browser, and so the caller decides which deployment the link points at.
 */
export async function buildSnapshotUrl(
  slug: string,
  view: SnapshotView,
  origin: string,
  base: string,
): Promise<SnapshotLink> {
  if (!supported()) return { kind: 'unsupported' }

  const payload: SnapshotPayload = {
    v: 1,
    slug,
    graph: toStored(view.data, view.capturedAt.getTime()),
    shown: view.showClosed,
  }
  const encoded = toBase64Url(await deflate(JSON.stringify(payload)))

  const prefix = base.endsWith('/') ? base : `${base}/`
  const url = `${origin}${prefix}dependencies/${slug}#${KEY}=${encoded}`

  if (url.length > SNAPSHOT_URL_LIMIT) {
    return { kind: 'too-large', chars: url.length, limit: SNAPSHOT_URL_LIMIT }
  }
  return { kind: 'ready', url }
}

/* Validating the payload -------------------------------------------------
   A fragment is untrusted input that anybody can hand-write, and everything it
   holds is fed straight into the layout and the cards. Checking only the two
   fields the decoder happens to touch leaves the rest to fail later and worse:
   an omitted `complete` reaches GraphStatus as `undefined`, which is falsy, so
   it renders the incomplete-graph warning and calls `.map` on an `unresolved`
   that is not there. A damaged link has to be caught here, where there is still
   a message to show and a live read to fall back to.

   The graph itself is checked by `isStoredGraph`, which lives with the module
   that owns the shape. A link and a saved copy carry the same payload under the
   same threat, so they are validated by the same function. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Whether a fragment claims to carry a snapshot at all.
 *
 * Synchronous, because the loader has to decide what to render on its very first frame: showing
 * the budget gate and replacing it once the payload has decompressed would flash a question the
 * recipient is never going to be asked.
 */
export function hasSnapshot(hash: string): boolean {
  const encoded = new URLSearchParams(hash.replace(/^#/, '')).get(KEY)
  return encoded !== null && encoded !== ''
}

/**
 * Reads a snapshot out of a location fragment.
 *
 * Every rejection names a reason, because a link that silently draws nothing is worse than one
 * that says it was damaged in transit: the recipient can still choose to read the repository live.
 */
export async function readSnapshot(hash: string, slug: string): Promise<SnapshotRead> {
  const encoded = new URLSearchParams(hash.replace(/^#/, '')).get(KEY)
  if (encoded === null || encoded === '') return { kind: 'none' }

  if (!supported()) {
    return { kind: 'invalid', reason: 'This browser cannot read shared links.' }
  }

  // Deliberately `unknown`: this is a hand-writable string, and asserting SnapshotPayload here
  // would let every field below be trusted on the strength of a cast.
  let payload: unknown
  try {
    payload = JSON.parse(await inflate(fromBase64Url(encoded)))
  } catch {
    return { kind: 'invalid', reason: 'This shared link is damaged or incomplete.' }
  }

  if (!isRecord(payload) || payload.v !== 1 || typeof payload.shown !== 'boolean') {
    return { kind: 'invalid', reason: 'This shared link was made by a different version.' }
  }
  // Case-insensitively: the sender's address bar and the recipient's need not agree on spelling,
  // and rejecting a link over that would be rejecting the repository it does hold.
  if (typeof payload.slug !== 'string' || canonicalSlug(payload.slug) !== canonicalSlug(slug)) {
    return {
      kind: 'invalid',
      reason: `This shared link holds ${String(payload.slug)}, not ${slug}.`,
    }
  }
  if (!isStoredGraph(payload.graph)) {
    return { kind: 'invalid', reason: 'This shared link is damaged or incomplete.' }
  }
  // A drawing that shows closed blockers cannot have come from a read that never fetched them.
  // The pair is contradictory rather than merely malformed, so it is rejected on its own terms.
  if (payload.shown && !payload.graph.includedClosed) {
    return { kind: 'invalid', reason: 'This shared link contradicts itself.' }
  }

  return {
    kind: 'snapshot',
    view: {
      data: fromStored(payload.graph),
      capturedAt: new Date(payload.graph.savedAt),
      showClosed: payload.shown,
    },
  }
}
