/**
 * Both repositories this viewer was built for label issues as `namespace: value`
 * (`type: bug`, `priority: P1`, `effort: L`, `status: needs-decision`). Parsing the convention
 * generically keeps the cards useful for repositories that follow it without breaking the ones
 * that do not: an unprefixed label simply renders as a plain chip.
 */

export interface LabelPayload {
  name: string
  color: string
}

export interface ParsedLabel {
  raw: string
  namespace: string | null
  value: string
  color: string
}

/** Namespaces that earn a place on the card first, in reading order. */
export const CARD_NAMESPACES = ['type', 'priority', 'effort', 'status'] as const

/** A card stays compact; beyond this the graph stops being scannable. */
export const MAX_CARD_LABELS = 4

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
 * A card shows the namespaces that say what the work is and how big it is, and nothing else.
 * `area:` and `evidence:` are real and useful in the issue list, but on a card they are long,
 * numerous and push the interesting labels out of view.
 *
 * A repository that uses no namespaces at all still gets chips, so the viewer stays generic.
 */
export function cardLabels(labels: LabelPayload[]): ParsedLabel[] {
  const parsed = parseLabels(labels)
  const known: ParsedLabel[] = []

  for (const namespace of CARD_NAMESPACES) {
    const match = parsed.find((label) => label.namespace === namespace)
    if (match) known.push(match)
  }

  if (known.length > 0) return known.slice(0, MAX_CARD_LABELS)
  return parsed.filter((label) => label.namespace === null).slice(0, MAX_CARD_LABELS)
}
