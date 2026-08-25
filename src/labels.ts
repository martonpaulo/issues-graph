/**
 * Both repositories this viewer was built for label issues as `namespace: value`
 * (`type: bug`, `priority: P1`, `effort: L`, `status: needs-decision`). Parsing the convention
 * generically keeps the cards useful for repositories that follow it; one that does not simply
 * shows three empty slots, and its labels are still reachable through the highlight picker.
 */

export interface LabelPayload {
  name: string
  color: string
}

/**
 * The three namespaces a card always shows, in this order. They answer what the work is, how
 * urgent it is, and how big it is — the three questions asked of a backlog item at a glance.
 */
export const CARD_NAMESPACES = ['type', 'priority', 'effort'] as const

export type CardNamespace = (typeof CARD_NAMESPACES)[number]

export interface ParsedLabel {
  raw: string
  namespace: string | null
  value: string
  color: string
}

/** One slot on a card. `value` is null when the issue carries no label for that namespace. */
export interface CardChip {
  namespace: CardNamespace
  value: string | null
}

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
 * The card's three slots, always all three.
 *
 * A missing one is shown as an empty slot rather than left out: a card with two chips and a card
 * with three would otherwise differ in a way that says nothing, while an outlined "effort" says
 * exactly what is missing and is worth filling in. Every other label the issue carries — `area:`,
 * `evidence:`, plain ones — stays off the card and is reachable through the label highlight.
 */
export function cardLabels(labels: LabelPayload[]): CardChip[] {
  const parsed = parseLabels(labels)
  return CARD_NAMESPACES.map((namespace) => ({
    namespace,
    value: valueOf(parsed, namespace),
  }))
}

/** How a slot reads on the card: the value when there is one, otherwise just the name. */
export function chipText(chip: CardChip): string {
  return chip.value === null ? chip.namespace : `${chip.namespace}: ${chip.value}`
}
