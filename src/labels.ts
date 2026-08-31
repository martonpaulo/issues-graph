/**
 * Both repositories this viewer was built for label issues as `namespace: value`
 * (`type: bug`, `priority: P1`, `effort: L`, `status: needs-decision`), and a card leads with
 * those three.
 *
 * It leads with them; it does not require them. Every other repository on GitHub labels issues
 * however it likes — `bug`, `good first issue`, `Component: DevTools` — and a card that recognized
 * none of that used to draw three dashed gaps and none of the labels the issue actually carried.
 * The convention is a hint about ordering here, never a precondition for showing anything.
 */

export interface LabelPayload {
  name: string
  color: string
}

/**
 * The three namespaces a card leads with, in this order. They answer what the work is, how urgent
 * it is, and how big it is — the three questions asked of a backlog item at a glance.
 */
export const CARD_NAMESPACES = ['type', 'priority', 'effort'] as const

export type CardNamespace = (typeof CARD_NAMESPACES)[number]

export interface ParsedLabel {
  raw: string
  namespace: string | null
  value: string
  color: string
}

/** One chip on a card. */
export interface CardChip {
  /** Exactly what the chip draws. GitHub's own text for a real label. */
  text: string
  /** The canonical namespace this chip fills or marks as missing; null for every other label. */
  namespace: CardNamespace | null
  /** A canonical slot the issue carries no label for, drawn as an outlined gap. */
  empty: boolean
}

/**
 * How many chips a card shows.
 *
 * A fixed budget rather than every label: the card is sized in `graph.ts` for the rows its chips
 * wrap onto, and a tabelo issue carrying eight labels would otherwise be half chips. Everything
 * that does not fit stays reachable through the label highlight, which is offered the full set.
 */
export const CARD_SLOT_COUNT = 3

/**
 * How many of the three namespaces an issue must carry before a missing one is drawn as a gap.
 *
 * One is not evidence. A repository whose only `namespace: value` label is `effort: M` is not
 * keeping this taxonomy, so dashed `type` and `priority` slots would assert something about it
 * that nothing supports — and would crowd out the labels it does use. Two is: an issue carrying
 * `type:` and `priority:` but no `effort:` is one this convention has something to say about, and
 * the outlined gap is exactly the thing worth filling in.
 */
const CONVENTION_THRESHOLD = 2

export function parseLabel(label: LabelPayload): ParsedLabel {
  const match = /^([a-z][a-z-]*):\s*(.+)$/i.exec(label.name)
  if (!match) {
    return { raw: label.name, namespace: null, value: label.name, color: label.color }
  }
  return {
    raw: label.name,
    namespace: match[1].toLowerCase(),
    value: match[2].trim(),
    color: label.color,
  }
}

export function parseLabels(labels: LabelPayload[]): ParsedLabel[] {
  return labels.map(parseLabel)
}

export function hasNamespace(labels: LabelPayload[], namespace: string): boolean {
  return parseLabels(labels).some((label) => label.namespace === namespace)
}

export function valueOf(labels: ParsedLabel[], namespace: string): string | null {
  return labels.find((label) => label.namespace === namespace)?.value ?? null
}

/**
 * The chips a card draws, at most `CARD_SLOT_COUNT` of them.
 *
 * The canonical namespaces come first and in their reading order, because on a backlog that keeps
 * them that ordering is the whole value of the row. Whatever budget they leave is filled with the
 * issue's other labels in GitHub's own order, so a repository this viewer knows nothing about
 * still gets a card that says what its issues are.
 *
 * A chip draws GitHub's text verbatim rather than a re-rendered `namespace: value`, so a label
 * spelled `Type: Bug` is shown the way its repository spells it.
 */
export function cardLabels(labels: LabelPayload[]): CardChip[] {
  const parsed = parseLabels(labels)

  const filled = new Map<CardNamespace, ParsedLabel>()
  for (const namespace of CARD_NAMESPACES) {
    const match = parsed.find((label) => label.namespace === namespace)
    if (match) filled.set(namespace, match)
  }
  const followsConvention = filled.size >= CONVENTION_THRESHOLD

  const slots: CardChip[] = []
  for (const namespace of CARD_NAMESPACES) {
    const match = filled.get(namespace)
    if (match) slots.push({ text: match.raw, namespace, empty: false })
    else if (followsConvention) slots.push({ text: namespace, namespace, empty: true })
  }

  const taken = new Set([...filled.values()].map((label) => label.raw))
  const rest: CardChip[] = parsed
    .filter((label) => !taken.has(label.raw))
    .map((label) => ({ text: label.raw, namespace: null, empty: false }))

  return [...slots, ...rest].slice(0, CARD_SLOT_COUNT)
}
