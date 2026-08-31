import type { IssuePayload, RepositoryGraphData, UnresolvedDependency } from './github'
import { CHIP_CHAR_WIDTHS, CHIP_FALLBACK_CHAR_WIDTH } from './interMetrics'
import { cardLabels, needsAttention, type CardChip } from './labels'
import { canonicalSlug, slugOf, type RepoTarget } from './route'

/**
 * Turns GitHub's payloads into a laid-out graph. Pure: no network, no React, no DOM. Every
 * dependency edge here comes from a native `blocked_by` relationship and every hierarchy edge from
 * a native `parent_issue_url` — issue prose is never read, so a body claiming "depends on #123"
 * cannot invent an edge.
 */

/** Every card is the same width; the height follows its title. */
export const NODE_WIDTH = 232

/**
 * A card is as tall as its title needs, between one line and five, and no taller.
 *
 * Uniform cards waste a column of empty space on short titles and truncate long ones at the same
 * time. The count is estimated from the text rather than measured, because this module is pure and
 * has to produce the same layout in a test as in a browser; the estimate is deliberately generous,
 * since a line too many only adds slack while a line too few would clip the title.
 */
export const MAX_TITLE_LINES = 5
const TITLE_LINE_HEIGHT = 17
/**
 * Width available to a title, expressed in quarter-character units. Most glyphs cost four; the
 * narrow glyphs below cost three. This keeps the old conservative 33-character bound for wide
 * text without reserving a second line for narrow text that Inter renders on one.
 */
const TITLE_UNITS_PER_LINE = 33 * 4
const TITLE_CHAR_UNITS = 4
const NARROW_TITLE_CHAR_UNITS = 3
const NARROW_TITLE_CHARS = new Set("fijltI1.,':;|!")
/** Border, padding, the number/state row, and the gap under it. Mirrors `.card` in styles.css. */
const CARD_CHROME = 38
/** Comfortable gap between the title and the chips under it. */
const LABELS_GAP = 11
/** One row of label chips, and the space between two rows. */
const CHIP_ROW_HEIGHT = 17
const CHIP_GAP = 4
/** A chip's own horizontal padding and border. Mirrors `.chip` in styles.css. */
const CHIP_PADDING = 12
/** The width the chips wrap inside: the card minus its padding. */
const CHIP_ROW_WIDTH = 210
/**
 * Held back from the row so a chip run that ends within a pixel of the edge is treated as wrapping.
 * One real combination — `type: improvement`, `priority: P2` and an empty `effort` — measures
 * 210.2px inside a 210px row, so the boundary is genuinely decided by fractions of a pixel; this
 * also covers the system face the browser draws with while Inter is still loading.
 */
const CHIP_ROW_SLACK = 1

/**
 * What one emoji costs.
 *
 * `CHIP_FALLBACK_CHAR_WIDTH` is the widest advance captured off Inter, which is the right guess
 * for a glyph Inter draws but the capture did not record — an accented latin letter, a CJK
 * ideograph the browser resolves to a face of about the same size. An emoji is not that: Inter has
 * no emoji glyphs at all, so the browser falls back to the system emoji face, which draws roughly
 * square and therefore wider than any Inter advance. Labels lead with one often enough on public
 * repositories to matter, and under-reserving is the direction that pushes chips out of the card.
 * A cluster spelled with several code points over-reserves, which only leaves slack.
 */
const CHIP_EMOJI_CHAR_WIDTH = 13

/** Symbol and pictographic blocks the shipped Inter face does not cover. */
function isEmoji(codePoint: number): boolean {
  return (
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2b00 && codePoint <= 0x2bff) ||
    codePoint >= 0x1f000
  )
}

/**
 * How wide the browser will draw one chip.
 *
 * Summed from the advances captured off the shipped Inter face rather than from an average
 * per-character width: Inter's advances run from 2.4px to 9.9px at 10px, and the cards that wrap
 * differ from the cards that do not by a fraction of a row, which no single average separates.
 * Kerning is not applied, which makes the sum marginally wider than the rendered text — 0.4px on
 * the longest chip a card shows — and that is the safe direction: a row too many only leaves a gap
 * while a row too few pushes the chips out of the card.
 */
function chipWidth(text: string): number {
  let width = CHIP_PADDING
  for (const character of text) {
    const captured = CHIP_CHAR_WIDTHS[character]
    if (captured !== undefined) {
      width += captured
      continue
    }
    width += isEmoji(character.codePointAt(0)!) ? CHIP_EMOJI_CHAR_WIDTH : CHIP_FALLBACK_CHAR_WIDTH
  }
  return width
}

function titleUnits(text: string): number {
  return [...text].reduce(
    (total, character) =>
      total + (NARROW_TITLE_CHARS.has(character) ? NARROW_TITLE_CHAR_UNITS : TITLE_CHAR_UNITS),
    0,
  )
}

export function titleLineCount(title: string, perLine = TITLE_UNITS_PER_LINE): number {
  const words = title.trim().split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 0) return 1

  let lines = 1
  let used = 0
  for (const word of words) {
    const wordWidth = titleUnits(word)
    const needed = used === 0 ? wordWidth : used + TITLE_CHAR_UNITS + wordWidth
    if (used > 0 && needed > perLine) {
      lines += 1
      used = wordWidth
    } else {
      used = needed
    }
    // A single word longer than the line wraps inside itself.
    while (used > perLine) {
      lines += 1
      used -= perLine
    }
  }

  return Math.min(MAX_TITLE_LINES, Math.max(1, lines))
}

/**
 * How many rows a card's chips wrap onto. Estimated from the text for the same reason the title's
 * lines are: this module is pure, and the layout has to agree with what the browser will draw.
 */
export function chipRows(texts: string[], width = CHIP_ROW_WIDTH): number {
  if (texts.length === 0) return 0

  const available = width - CHIP_ROW_SLACK
  let rows = 1
  let used = 0
  for (const text of texts) {
    const chip = Math.min(available, chipWidth(text))
    const needed = used === 0 ? chip : used + CHIP_GAP + chip
    if (used > 0 && needed > available) {
      rows += 1
      used = chip
    } else {
      used = needed
    }
  }
  return rows
}

export function cardHeight(titleLines: number, rows: number): number {
  const chips = rows > 0 ? LABELS_GAP + rows * CHIP_ROW_HEIGHT + (rows - 1) * CHIP_GAP : 0
  return CARD_CHROME + titleLines * TITLE_LINE_HEIGHT + chips
}

export type IssueState =
  | 'ready'
  | 'unassigned'
  | 'blocked'
  | 'in-progress'
  | 'attention'
  | 'in-review'
  | 'completed'
  | 'not-planned'

export interface GraphNode {
  id: string
  number: number
  title: string
  url: string
  repo: string
  /** Local workflow presentation state. External repositories do not share this convention. */
  state: IssueState | null
  /**
   * Whether GitHub still has the issue open.
   *
   * Separate from `state` on purpose. `state` is this repository's own reading of a backlog —
   * `ready`, `blocked`, `needs attention` — built from a label convention nobody else has agreed
   * to, so it is withheld for an issue in another repository. Open or closed is GitHub's own fact
   * and means the same everywhere, and it is the one thing that has to be said about a blocker:
   * a closed one is no longer in the way.
   */
  open: boolean
  /** True when the issue lives in another repository and was reached as a blocker. */
  external: boolean
  /**
   * How that other repository is named on the card: the bare repository when the owner is the one
   * being viewed, the full `owner/repo` when it is somebody else's. Empty for a local issue.
   */
  repoLabel: string
  /** The chips the card draws, canonical slots first. External cards draw none. */
  labels: CardChip[]
  /** Every label on the issue, which is what the highlight picker offers. */
  allLabels: string[]
  /**
   * How far this issue's native sub-issues have got, or null when it has none. Null is also what
   * an external card carries: the count belongs to a repository this view is not reading.
   */
  subIssues: SubIssuesProgress | null
  /** Lines the title is allowed, and the height that leaves the card. */
  titleLines: number
  height: number
  position: { x: number; y: number }
}

/** What one edge asserts. The two are different relations and are drawn differently. */
export type EdgeKind = 'dependency' | 'hierarchy'

export interface SubIssuesProgress {
  completed: number
  total: number
}

export interface GraphEdge {
  id: string
  /**
   * `dependency`: the source has to land first. `hierarchy`: the source contains the target.
   * Containment carries no ordering, which is why it never shares a style with a dependency.
   */
  kind: EdgeKind
  /** The blocker for a dependency, the parent for a hierarchy edge. */
  source: string
  target: string
  /** The orthogonal route the layout reserved for this edge, in canvas coordinates. */
  points?: Point[]
  /**
   * True when this edge runs against the canvas's top-to-bottom order, so its direction cannot be
   * read from position and has to be stated. Only ever set on a hierarchy edge; see
   * {@link invertedEdges}.
   */
  inverted?: boolean
}

/**
 * A frame drawn behind a set of cards.
 *
 * `chain` is one weakly-connected set of dependencies: work that has to be finished as a unit, in
 * the order the arrows give. `breakdown` is a set held together only by containment — a parent and
 * its sub-issues, which have no order between them. `free` is everything connected to nothing at
 * all, which can be picked up in any order.
 */
export interface GraphGroup {
  id: string
  kind: 'chain' | 'breakdown' | 'free'
  label: string
  members: string[]
  position: { x: number; y: number }
  width: number
  height: number
}

export interface IssueGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  groups: GraphGroup[]
  /**
   * The repository this drawing is of, canonically, and the repository every node ID is qualified
   * with. It is not always the address the reader is on: a rename redirect serves one repository
   * under an older name, and a trusted read then answers with the current one.
   *
   * Anything that has to survive leaving this browser is bound to this rather than to the address.
   * A shared link built from the address would carry issues the recipient reads as somebody else's
   * — the recipient does not trust the payload to name its own repository, and rightly — so the
   * link would draw every card as external and join no edges at all.
   */
  identity: string
  /** False when any dependency could not be read. The canvas must say so rather than imply whole. */
  complete: boolean
  unresolved: UnresolvedDependency[]
  rateLimited: boolean
  rateLimitReset: Date | null
  requestCount: number
}

/** `https://api.github.com/repos/owner/name` -> `owner/name`. */
export function repoOf(repositoryUrl: string): string {
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(repositoryUrl)
  return match ? match[1] : 'unknown/unknown'
}

/**
 * The graph's identity for one issue. The repository half is canonicalized, so a card reached
 * through the route and the same card reached as somebody's blocker are one node however the two
 * payloads spell the repository.
 */
export function nodeId(repo: string, number: number): string {
  return `${canonicalSlug(repo)}#${number}`
}

export function isOpen(issue: IssuePayload): boolean {
  return issue.state !== 'closed'
}

/**
 * The two bare label names the orchestrator matches, case-insensitively, against the whole label
 * name. Neither carries a `:`, so neither reaches a card slot and neither can be found by asking
 * for a namespace.
 * https://github.com/martonpaulo/skills — `.ao/worker-rules.md` documents both.
 */
const IN_PROGRESS_LABEL = 'in-progress'
const IN_REVIEW_LABEL = 'in-review'

function hasLabel(issue: IssuePayload, name: string): boolean {
  return issue.labels.some((label) => label.name.trim().toLowerCase() === name)
}

/**
 * State comes from GitHub, never from inference.
 *
 * The order below is the order the facts override one another, and each step answers the same
 * question: what will actually happen to this issue next?
 *
 * 1. `in-review` first, because an issue whose change is already written and waiting is the one
 *    error that costs somebody a second implementation of finished work.
 * 2. A `status:` label whose value this convention defines next. Its description says
 *    `in-progress` travels with every one of them, so the pair means the issue is parked on a
 *    human, and parked is the fact worth showing. The value is what is matched, never the
 *    namespace: `status:` is a namespace half of GitHub uses for board columns, and a repository
 *    whose issues sit in `status: backlog` is not a repository of issues waiting on somebody.
 * 3. `in-progress` alone: a worker is holding it right now.
 * 4. `blocked_by` counts blockers that are still **open**, while `total_blocked_by` counts open and
 *    closed ones. So `blocked_by > 0` is exactly "has an unfinished blocker", and an issue whose
 *    blockers have all closed reads as ready even though its total stays non-zero.
 * 5. Unassigned, which is not the same as free to start: with nobody on it the issue is unqueued,
 *    and reading it as ready is what makes an untouched backlog look like a work queue. An issue
 *    payload carrying no `assignees` field at all — an older cached copy or a shared snapshot —
 *    is unknown rather than empty, and falls through to what it used to render as.
 *
 * Each label is read on its own terms, so removing one leaves the other correct.
 */
export function deriveState(issue: IssuePayload): IssueState {
  if (issue.state === 'closed') {
    return issue.state_reason === 'not_planned' ? 'not-planned' : 'completed'
  }
  if (hasLabel(issue, IN_REVIEW_LABEL)) return 'in-review'
  if (needsAttention(issue.labels)) return 'attention'
  if (hasLabel(issue, IN_PROGRESS_LABEL)) return 'in-progress'
  if ((issue.issue_dependencies_summary?.blocked_by ?? 0) > 0) return 'blocked'
  if (issue.assignees?.length === 0) return 'unassigned'
  return 'ready'
}

/** A parent's progress, or null when the issue is not a parent. */
export function subIssuesOf(issue: IssuePayload): SubIssuesProgress | null {
  const summary = issue.sub_issues_summary
  if (!summary || summary.total <= 0) return null
  return { completed: summary.completed, total: summary.total }
}

/**
 * `https://api.github.com/repos/owner/name/issues/294` -> the node id it would have.
 *
 * Returns null for anything else, which includes the absent field an issue without a parent
 * carries. The parent may well live in another repository — several of this owner's do — and that
 * id simply matches no node, which is exactly the outcome wanted: the edge is dropped rather than
 * paid for with a request into a repository this view is not reading.
 */
export function parentNodeId(parentIssueUrl: string | null | undefined): string | null {
  if (!parentIssueUrl) return null
  const match = /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(parentIssueUrl)
  return match ? nodeId(match[1], Number(match[2])) : null
}

function toNode(issue: IssuePayload, targetSlug: string): GraphNode {
  const repo = repoOf(issue.repository_url)
  const external = canonicalSlug(repo) !== canonicalSlug(targetSlug)
  const [owner, name] = repo.split('/')
  const sameOwner = canonicalSlug(owner) === canonicalSlug(targetSlug.split('/')[0])
  const repoLabel = external ? (sameOwner ? name : repo) : ''
  const state = external ? null : deriveState(issue)
  const labels = external ? [] : cardLabels(issue.labels)
  const titleLines = titleLineCount(issue.title)
  const rows = chipRows(labels.map((chip) => chip.text))
  return {
    id: nodeId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    repo,
    state,
    open: isOpen(issue),
    external,
    repoLabel,
    labels,
    allLabels: issue.labels.map((label) => label.name),
    subIssues: external ? null : subIssuesOf(issue),
    titleLines,
    height: cardHeight(titleLines, rows),
    position: { x: 0, y: 0 },
  }
}

/** Space between cards in the block of issues that depend on nothing. */
const GRID_GAP = 20
/** Space between that block and the drawn dependencies above it. */
const BLOCK_GAP = 80

/** Breathing room inside a group frame, and the strip its label sits in above the cards. */
export const GROUP_PADDING = 14
export const GROUP_LABEL_HEIGHT = 24

/** Roughly 16:9, so a whole graph lands on a screen after fit-to-view. */
const TARGET_ASPECT = 1.9

export interface Point {
  x: number
  y: number
}

/**
 * How the dependencies are drawn.
 *
 * ELK's `layered` algorithm is the same family of algorithm as dagre — assign ranks, order within
 * a rank to reduce crossings, then place — but it also routes the edges, which is the part that
 * decides whether a dense graph can be read at all. `ORTHOGONAL` routing reserves lanes between
 * the rows, gives each edge of a card its own point on that card's border, and takes an edge that
 * spans several ranks around the cards it passes instead of through them.
 *
 * https://eclipse.dev/elk/reference/options.html
 */
const ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.spacing.nodeNode': '28',
  'elk.layered.spacing.nodeNodeBetweenLayers': '76',
  'elk.spacing.edgeNode': '20',
  'elk.spacing.edgeEdge': '16',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
  // Each connected piece of work is laid out on its own and the pieces are packed to a screen
  // shape, so a backlog of small chains does not open as one enormous row.
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '76',
  'elk.aspectRatio': String(TARGET_ASPECT),
}

interface ElkNode {
  id: string
  width?: number
  height?: number
  x?: number
  y?: number
  children?: ElkNode[]
  edges?: ElkEdge[]
  layoutOptions?: Record<string, string>
}

interface ElkEdge {
  id: string
  sources: string[]
  targets: string[]
  sections?: { startPoint: Point; bendPoints?: Point[]; endPoint: Point }[]
}

interface ElkEngine {
  layout(graph: ElkNode): Promise<ElkNode>
  /** Present only for the worker engine; the bundled one runs on the thread that called it. */
  terminate?(): void
}

let engine: Promise<ElkEngine> | null = null
/**
 * What `engine` resolved to, kept beside it so a discard can decide *and* detach without awaiting.
 * Reading the engine out of its own promise is a turn too late: the memo would still be handing the
 * doomed engine to anything that asked in between.
 */
let ready: ElkEngine | null = null

/**
 * A real worker where the platform has one, and the bundled engine where it does not.
 *
 * Measured in Chrome, one layout on the page's own thread is a single long task — 66–88 ms for a
 * 25-node graph, 672 ms at 250 nodes — during which the page cannot paint or
 * answer a click. The worker moves that off the main thread and makes the work stoppable, which is
 * the only way an ELK layout can be stopped.
 *
 * The budget those figures were read against is the platform's own 50 ms, agreed under #16. See
 * `docs/research/elk-layout-main-thread-cost.md` for the measurement and the decision.
 *
 * The fallback is not a nicety: the tests run this module under Node, where `Worker` does not
 * exist, and the layout they assert on is the same algorithm either way.
 */
async function createEngine(): Promise<ElkEngine> {
  if (typeof Worker !== 'undefined') {
    const { workerEngine } = await import('./layoutWorker')
    return workerEngine() as ElkEngine
  }
  const module = await import('elkjs/lib/elk.bundled.js')
  return new (module.default as unknown as new () => ElkEngine)()
}

/**
 * ELK is a megabyte of compiled Java, so it is fetched only when a graph is actually drawn and
 * kept for the rest of the session.
 *
 * Only a *settled-successful* engine is worth keeping. Memoizing the Promise itself means a
 * rejected chunk load — a deploy that moved the asset, a network blip, an offline moment — is kept
 * with the same permanence as a working engine, and every later draw in the session re-awaits that
 * one rejection however healthy the network has since become. Clearing the slot on rejection is
 * what makes the retry the reader is already offered actually retry something.
 */
async function elk(): Promise<ElkEngine> {
  if (!engine) {
    const attempt: Promise<ElkEngine> = createEngine()
      .then((created) => {
        if (engine === attempt) ready = created
        return created
      })
      .catch((error: unknown) => {
        // Cleared only while this attempt is still the one on record, so a later attempt that has
        // already replaced it — and may well have succeeded — is not discarded by an older failure.
        if (engine === attempt) {
          engine = null
          ready = null
        }
        throw error
      })
    engine = attempt
  }
  return engine
}

/**
 * Drops the memoized engine and terminates it.
 *
 * `used` narrows that to one engine: a layout that failed says its own engine is no longer
 * trustworthy, but by the time the failure is handled the memo may already hold a replacement that
 * is perfectly healthy, and taking that one down would turn one failed draw into two.
 */
function discard(used: ElkEngine | null): void {
  const held = engine
  if (!held) return
  // Whether this discard applies is decided here rather than inside the callback below, because
  // `ready` already knows what the memo holds.
  if (used && ready !== used) return
  // Detached before anything is awaited. Resolving the engine first to identify it left the memo
  // pointing at it for a further turn, so a draw beginning in that window — a close and an
  // immediate remount is exactly that — was handed an engine on its way to being terminated.
  engine = null
  ready = null
  void held.then(
    (current) => current.terminate?.(),
    () => {
      // An attempt that never produced an engine has nothing to terminate, and its rejection
      // belongs to whoever asked for it.
    },
  )
}

/**
 * Stops a layout whose result nobody is waiting for any more.
 *
 * ELK offers no cancellation, so the running layout can only be discarded — but a worker can be
 * terminated, and that is the difference between "the result is ignored" and "the work stops". The
 * engine is dropped with it, so the next draw builds a fresh one.
 *
 * Call this only when no draw still wants an answer: one worker serves every layout, and
 * terminating it takes the current one down too.
 */
export function discardLayoutEngine(): void {
  discard(null)
}

/** Weakly-connected components: edge direction does not matter for grouping. */
function componentsOf(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[][] {
  const parent = new Map<string, string>(nodes.map((node) => [node.id, node.id]))

  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    while (parent.get(id) !== root) {
      const next = parent.get(id)!
      parent.set(id, root)
      id = next
    }
    return root
  }

  for (const edge of edges) {
    const a = find(edge.source)
    const b = find(edge.target)
    if (a !== b) parent.set(a, b)
  }

  const groups = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    const root = find(node.id)
    const group = groups.get(root)
    if (group) group.push(node)
    else groups.set(root, [node])
  }
  return [...groups.values()]
}

/**
 * The hierarchy edges that contradict a dependency edge between the same two issues.
 *
 * A parent split into sub-issues and then blocked by them is legitimate data, and the two relations
 * it produces disagree about direction: containment puts the parent above its children, ordering
 * puts a blocker above what it blocks. No layout satisfies both, so one of them has to be drawn
 * against the canvas's top-to-bottom order.
 *
 * Ordering wins, and the choice is not a coin toss. This canvas exists to answer what unlocks what,
 * containment carries no order at all — `kindOf` calls a purely contained component a breakdown
 * rather than a chain, and `dependencyCounts` ignores hierarchy edges outright — and, decisively, a
 * dependency edge is drawn with an arrowhead while a hierarchy edge deliberately is not. An arrow
 * still says which end comes first wherever it is drawn; a dashed line with no marker says nothing
 * but where its ends sit. So the relation whose meaning survives inversion is the one kept upright,
 * and the one that would lose its meaning is marked instead: these ids get `inverted`, and the
 * canvas draws them with the arrowhead their ordinary style does without.
 *
 * Deciding it here rather than leaving the cycle to ELK also makes it deterministic. Handed a
 * two-node cycle the engine breaks it however it likes, so the same repository could mark different
 * edges between two versions of it.
 */
export function invertedEdges(edges: GraphEdge[]): Set<string> {
  const blocks = new Set<string>()
  for (const edge of edges) {
    if (edge.kind === 'dependency') blocks.add(`${edge.source} ${edge.target}`)
  }

  const inverted = new Set<string>()
  for (const edge of edges) {
    if (edge.kind !== 'hierarchy') continue
    if (blocks.has(`${edge.target} ${edge.source}`)) inverted.add(edge.id)
  }
  return inverted
}

const GROUP_WORD: Record<GraphGroup['kind'], string> = {
  chain: 'Chain',
  breakdown: 'Breakdown',
  free: 'Independent',
}

function groupLabel(kind: GraphGroup['kind'], count: number): string {
  const issues = `${count} issue${count === 1 ? '' : 's'}`
  // The frames mean different things, so each says which it is rather than leaving the reader to
  // infer it from a border style. A breakdown is emphatically not a chain: its members contain one
  // another and can be picked up in any order.
  return `${GROUP_WORD[kind]} · ${issues}`
}

/** Frames a set of cards from where they actually landed. */
function frameOf(members: GraphNode[], kind: GraphGroup['kind']): GraphGroup {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const node of members) {
    left = Math.min(left, node.position.x)
    top = Math.min(top, node.position.y)
    right = Math.max(right, node.position.x + NODE_WIDTH)
    bottom = Math.max(bottom, node.position.y + node.height)
  }

  const ids = members.map((node) => node.id).sort()
  return {
    id: `group:${ids[0]}`,
    kind,
    label: groupLabel(kind, members.length),
    members: ids,
    position: { x: left - GROUP_PADDING, y: top - GROUP_PADDING - GROUP_LABEL_HEIGHT },
    width: right - left + GROUP_PADDING * 2,
    height: bottom - top + GROUP_PADDING * 2 + GROUP_LABEL_HEIGHT,
  }
}

/**
 * Packs the issues that depend on nothing into their own block.
 *
 * They have no edges, so a layered algorithm has nothing to say about them and would only spread
 * them across the canvas. Filling the shortest column each time keeps the block dense even though
 * the cards differ in height.
 */
function packLoose(nodes: GraphNode[], columns: number, originY: number): void {
  const used = Math.max(1, Math.min(columns, nodes.length))
  const heights = new Array<number>(used).fill(originY)

  for (const node of nodes) {
    let column = 0
    for (let index = 1; index < used; index += 1) {
      if (heights[index] < heights[column]) column = index
    }
    node.position = { x: column * (NODE_WIDTH + GRID_GAP), y: heights[column] }
    heights[column] += node.height + GRID_GAP
  }
}

export interface Layout {
  nodes: GraphNode[]
  groups: GraphGroup[]
  /** Edge id to the orthogonal route ELK reserved for it. */
  routes: Map<string, Point[]>
}

/**
 * Lays the graph out: ELK draws everything that has a dependency, and the rest is packed beneath
 * it as one block, because an issue that blocks nothing and waits for nothing has no place in a
 * layered drawing beyond taking up room in it.
 */
export async function layout(nodes: GraphNode[], edges: GraphEdge[]): Promise<Layout> {
  if (nodes.length === 0) return { nodes, groups: [], routes: new Map() }

  const components = componentsOf(nodes, edges)
  // Handed to ELK the other way round, so the engine never sees the two-node cycle a parent blocked
  // by its own sub-issues makes, and every dependency edge comes back pointing down the canvas.
  const inverted = invertedEdges(edges)
  const connected = components.filter((group) => group.length > 1)
  const loose = components.filter((group) => group.length === 1).flat()
  const placed = new Map<string, GraphNode>(
    nodes.map((node) => [node.id, { ...node, position: { x: 0, y: 0 } }]),
  )
  const routes = new Map<string, Point[]>()
  const groups: GraphGroup[] = []
  let drawnHeight = 0
  let drawnWidth = NODE_WIDTH * 4

  // A component held together only by containment is not a chain, and saying so is the whole point
  // of drawing the two relations differently in the first place.
  const ordered = new Set<string>()
  for (const edge of edges) {
    if (edge.kind !== 'dependency') continue
    ordered.add(edge.source)
    ordered.add(edge.target)
  }
  const kindOf = (component: GraphNode[]): GraphGroup['kind'] =>
    component.some((node) => ordered.has(node.id)) ? 'chain' : 'breakdown'

  if (connected.length > 0) {
    const members = connected.flat()
    const ids = new Set(members.map((node) => node.id))
    const engineUsed = await elk()
    let result: ElkNode
    try {
      result = await engineUsed.layout({
        id: 'root',
        layoutOptions: ELK_OPTIONS,
        children: members.map((node) => ({
          id: node.id,
          width: NODE_WIDTH,
          height: node.height,
        })),
        edges: edges
          .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
          .map((edge) =>
            inverted.has(edge.id)
              ? { id: edge.id, sources: [edge.target], targets: [edge.source] }
              : { id: edge.id, sources: [edge.source], targets: [edge.target] },
          ),
      })
    } catch (error) {
      // The engine that just failed is kept for the rest of the session otherwise, so the retry the
      // reader is offered would hand the same draw to the same dead worker and fail identically.
      // Rebuilding one is cheap; retrying against a corpse is not a retry at all.
      discard(engineUsed)
      throw error
    }

    for (const child of result.children ?? []) {
      const node = placed.get(child.id)
      if (node) node.position = { x: child.x ?? 0, y: child.y ?? 0 }
    }

    for (const edge of result.edges ?? []) {
      const section = edge.sections?.[0]
      if (!section) continue
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
      // The route ELK drew runs the way it was asked, so a reversed edge gets its route turned back
      // round: the polyline still leaves the parent and arrives at the child, which is where the
      // arrowhead marking the inversion has to land.
      routes.set(edge.id, inverted.has(edge.id) ? points.reverse() : points)
    }

    for (const component of connected) {
      groups.push(frameOf(component.map((node) => placed.get(node.id)!), kindOf(component)))
    }

    drawnWidth = Math.max(drawnWidth, ...groups.map((group) => group.position.x + group.width))
    drawnHeight = Math.max(...groups.map((group) => group.position.y + group.height))
  }

  if (loose.length > 0) {
    // The block is shaped for the screen in its own right: taking the drawn width alone would
    // leave a repository with two small chains and forty loose issues as one tall column.
    const area = loose.reduce(
      (sum, node) => sum + (NODE_WIDTH + GRID_GAP) * (node.height + GRID_GAP),
      0,
    )
    const wanted = Math.max(drawnWidth, Math.sqrt(area * TARGET_ASPECT))
    const columns = Math.max(1, Math.round(wanted / (NODE_WIDTH + GRID_GAP)))
    const block = loose.map((node) => placed.get(node.id)!)
    packLoose(block, columns, connected.length > 0 ? drawnHeight + BLOCK_GAP : 0)
    groups.push(frameOf(block, 'free'))
  }

  return { nodes: nodes.map((node) => placed.get(node.id)!), groups, routes }
}

/**
 * How many issues wait on something, and how many hold something up.
 *
 * Counted from the dependency edges alone. Containment is not ordering: a parent holds none of its
 * children up and waits on none of them, so a hierarchy edge must reach neither figure.
 */
export function dependencyCounts(edges: GraphEdge[]): { dependent: number; blocking: number } {
  const dependent = new Set<string>()
  const blocking = new Set<string>()
  for (const edge of edges) {
    if (edge.kind !== 'dependency') continue
    dependent.add(edge.target)
    blocking.add(edge.source)
  }
  return { dependent: dependent.size, blocking: blocking.size }
}

export interface BuildOptions {
  /**
   * Draws closed blockers and the edges into them. Off by default: a finished blocker no longer
   * blocks, so the issue it used to block belongs with the work that is ready to start, and a
   * backlog reads as what is left to do rather than as what has already happened.
   */
  showClosed?: boolean
  /**
   * Lets the payloads name the repository being drawn, rather than the address the reader is on.
   *
   * True only for data this browser read from GitHub, or its own saved copy of such a read. A
   * shared link's payload is a hand-writable string: `readSnapshot` binds the link to the
   * repository in its path, and trusting the issues inside it to name the repository would hand
   * that binding straight back to whoever wrote the link, letting somebody else's issues be drawn
   * as local under an address that names a repository they have nothing to do with. Off by
   * default, so a caller that has not thought about provenance gets the address it is on.
   */
  trustedIdentity?: boolean
}

/**
 * Which repository the drawing is of.
 *
 * Every issue in a trusted `data.issues` came from the repository GitHub resolved the request to,
 * so its `repository_url` carries GitHub's own spelling of that repository. The route's spelling
 * can differ — owner and repository path parameters are not case-sensitive, and a renamed
 * repository is still served under its old name through a redirect — and deriving node IDs from
 * the route is how the same issue ended up as two identities, one of them wrongly external, with
 * every edge between them lost.
 *
 * Untrusted data never gets that authority, and neither does an empty read, where there is nothing
 * to join anyway: both fall back to the address, which is bound to the repository elsewhere.
 * Identity is only ever compared canonically, so the fallback still joins every casing of the
 * address to the payloads' own spelling of the same name.
 *
 * https://docs.github.com/en/rest/issues/issue-dependencies
 */
function resolvedTarget(data: RepositoryGraphData, target: RepoTarget, trusted: boolean): string {
  const first = trusted ? data.issues[0] : undefined
  return first ? repoOf(first.repository_url) : slugOf(target)
}

export async function buildGraph(
  data: RepositoryGraphData,
  target: RepoTarget,
  options: BuildOptions = {},
): Promise<IssueGraph> {
  const showClosed = options.showClosed === true
  const targetSlug = resolvedTarget(data, target, options.trustedIdentity === true)
  const nodes = new Map<string, GraphNode>()
  // The list is of open issues; this guards the invariant rather than expecting to drop anything.
  for (const issue of data.issues) {
    if (!isOpen(issue)) continue
    const node = toNode(issue, targetSlug)
    nodes.set(node.id, node)
  }

  const edges: GraphEdge[] = []
  const seen = new Set<string>()

  for (const [number, blockers] of data.blockers) {
    const targetId = nodeId(targetSlug, number)
    if (!nodes.has(targetId)) continue

    for (const blocker of blockers) {
      if (!showClosed && !isOpen(blocker)) continue

      // A blocker in another repository is not in the issue list, so it joins the graph here.
      const blockerNode = toNode(blocker, targetSlug)
      if (!nodes.has(blockerNode.id)) nodes.set(blockerNode.id, blockerNode)

      const id = `${blockerNode.id}->${targetId}`
      if (seen.has(id)) continue
      seen.add(id)
      edges.push({ id, kind: 'dependency', source: blockerNode.id, target: targetId })
    }
  }

  // Hierarchy is read off the children, which is where GitHub puts it, so it costs no request of
  // its own. Only a parent that is already a node produces an edge: a parent in another repository
  // is named by the child and is deliberately not fetched, exactly as an outbound `blocking` edge
  // is not. Closed parents are absent for the same reason closed blockers are.
  for (const issue of data.issues) {
    if (!isOpen(issue)) continue
    const childId = nodeId(repoOf(issue.repository_url), issue.number)
    if (!nodes.has(childId)) continue

    const parentId = parentNodeId(issue.parent_issue_url)
    if (!parentId || parentId === childId || !nodes.has(parentId)) continue

    const id = `${parentId}=>${childId}`
    if (seen.has(id)) continue
    seen.add(id)
    edges.push({ id, kind: 'hierarchy', source: parentId, target: childId })
  }

  const laid = await layout([...nodes.values()], edges)
  const inverted = invertedEdges(edges)

  return {
    nodes: laid.nodes,
    edges: edges.map((edge) => ({
      ...edge,
      points: laid.routes.get(edge.id),
      inverted: inverted.has(edge.id) || undefined,
    })),
    groups: laid.groups,
    identity: canonicalSlug(targetSlug),
    complete: data.complete,
    unresolved: data.unresolved,
    rateLimited: data.rateLimited,
    rateLimitReset: data.rateLimitReset,
    requestCount: data.requestCount,
  }
}
