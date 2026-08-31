import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useRef } from 'react'

import { issueRef } from './dependencies'
import type { GraphNode, IssueState } from './graph'
import { Icon } from './icons'
import { chipText } from './labels'

export interface IssueCardData extends Record<string, unknown> {
  node: GraphNode
  selected: boolean
  hidden: boolean
  /** Carries a label the reader asked to pick out. */
  highlighted: boolean
  /** A highlight is on and this card is not part of it. */
  faded: boolean
  /**
   * The card's place in the dependency graph, said in words, e.g.
   * `Issue #25. Blocked by #23 and #24. Blocks #31.` Derived from the drawn edges by
   * `dependencies.ts`, and read to anyone who cannot trace the arrows.
   */
  description: string
  onSelect: (id: string, additive: boolean) => void
  onToggleHidden: (id: string) => void
  onOpen: (url: string, label: string) => void
}

/** Past this, a pointer press was a pan across the canvas rather than a click on the card. */
const DRAG_SLOP = 4

export type IssueNode = Node<IssueCardData, 'issue'>

/**
 * State is written on the card as words, not carried by colour alone, so the graph stays readable
 * for anyone who cannot separate the fills.
 */
export const STATE_TEXT: Record<IssueState, string> = {
  ready: 'ready',
  blocked: 'blocked',
  attention: 'needs attention',
  completed: 'closed',
  'not-planned': 'not planned',
}

function cardClasses(data: IssueCardData): string {
  const { node, selected, hidden, highlighted, faded } = data

  return [
    'card',
    node.state ? `card--${node.state}` : '',
    node.external ? 'card--external' : '',
    selected ? 'card--selected' : '',
    hidden ? 'card--hidden' : '',
    highlighted ? 'card--highlight' : '',
    faded ? 'card--faded' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * Selection is the card's own job; the two icons are the only things that leave it.
 * The body deliberately carries no `nopan`, so a drag that starts on a card still moves the
 * canvas — the slop check is what keeps that drag from also toggling selection.
 */
function CardBody({
  node,
  selected,
  description,
  onSelect,
}: Pick<IssueCardData, 'node' | 'selected' | 'description' | 'onSelect'>) {
  const pressedAt = useRef<{ x: number; y: number } | null>(null)
  // The node id carries `/` and `#`, which are legal in an id but are selector syntax everywhere
  // else, so the reference is spelled without them.
  const descriptionId = `card-deps-${node.id.replace(/[^\w-]+/g, '-')}`

  return (
    <button
      type="button"
      className="card__body nodrag"
      aria-pressed={selected}
      aria-describedby={descriptionId}
      onPointerDown={(event) => {
        pressedAt.current = { x: event.clientX, y: event.clientY }
      }}
      onClick={(event) => {
        const from = pressedAt.current
        pressedAt.current = null
        if (
          from &&
          (Math.abs(event.clientX - from.x) > DRAG_SLOP ||
            Math.abs(event.clientY - from.y) > DRAG_SLOP)
        ) {
          return
        }
        onSelect(node.id, event.metaKey || event.ctrlKey)
      }}
    >
      <span className="card__head">
        {/* The repository belongs with the number: on its own the number means nothing, since
            it belongs to somebody else's numbering. */}
        <span className="card__id">
          {node.external && <span className="card__repo">{node.repoLabel}</span>}
          <span className="card__number">#{node.number}</span>
        </span>
        {node.state && <span className="card__state">{STATE_TEXT[node.state]}</span>}
      </span>

      <span
        className="card__title"
        style={{ WebkitLineClamp: node.titleLines, lineClamp: node.titleLines }}
      >
        {node.title}
      </span>

      {/* The arrows are geometry, and geometry is exactly what a screen reader cannot follow.
          Hidden rather than drawn: the same fact is already on screen as an edge. */}
      <span className="sr-only" id={descriptionId}>
        {description}
      </span>

      <span className="card__labels">
        {node.labels.map((chip) => (
          <span
            key={chip.namespace}
            className={`chip${chip.value === null ? ' chip--empty' : ''}`}
          >
            {chipText(chip)}
          </span>
        ))}
      </span>
    </button>
  )
}

/** The two controls that act on the issue itself rather than on the selection. */
function CardActions({
  node,
  label,
  hidden,
  onToggleHidden,
  onOpen,
}: Pick<IssueCardData, 'node' | 'hidden' | 'onToggleHidden' | 'onOpen'> & { label: string }) {
  return (
    <span className="card__actions nodrag nopan">
      <button
        type="button"
        className="iconbutton"
        aria-label={`Open ${label} on GitHub`}
        data-tip="Open on GitHub · Enter"
        onClick={() => onOpen(node.url, `${label} · ${node.title}`)}
      >
        <Icon name="external" size={12} />
      </button>
      <button
        type="button"
        className="iconbutton"
        aria-label={hidden ? `Show ${label}` : `Hide ${label}`}
        aria-pressed={hidden}
        data-tip={hidden ? 'Show this issue · S' : 'Hide this issue · H'}
        onClick={() => onToggleHidden(node.id)}
      >
        <Icon name={hidden ? 'eye-off' : 'eye'} size={12} />
      </button>
    </span>
  )
}

export function IssueCard({ data }: NodeProps<IssueNode>) {
  const { node, selected, hidden, description, onSelect, onToggleHidden, onOpen } = data
  const label = issueRef(node)

  return (
    <div className={cardClasses(data)}>
      <Handle type="target" position={Position.Top} className="card__handle" />

      <CardBody
        node={node}
        selected={selected}
        description={description}
        onSelect={onSelect}
      />

      <CardActions
        node={node}
        label={label}
        hidden={hidden}
        onToggleHidden={onToggleHidden}
        onOpen={onOpen}
      />

      <Handle type="source" position={Position.Bottom} className="card__handle" />
    </div>
  )
}
