import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useRef } from 'react'

import type { GraphNode, IssueState } from './graph'
import { Icon } from './icons'

export interface IssueCardData extends Record<string, unknown> {
  node: GraphNode
  selected: boolean
  hidden: boolean
  /** Carries a label the reader asked to pick out. */
  highlighted: boolean
  /** A highlight is on and this card is not part of it. */
  faded: boolean
  onToggleSelect: (id: string) => void
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
const STATE_TEXT: Record<IssueState, string> = {
  ready: 'ready',
  blocked: 'blocked',
  attention: 'needs attention',
  completed: 'closed',
  'not-planned': 'not planned',
}

export function IssueCard({ data }: NodeProps<IssueNode>) {
  const { node, selected, hidden, highlighted, faded, onToggleSelect, onToggleHidden, onOpen } =
    data
  const label = node.external ? `${node.repo}#${node.number}` : `#${node.number}`
  const pressedAt = useRef<{ x: number; y: number } | null>(null)

  const classes = [
    'card',
    `card--${node.state}`,
    node.external ? 'card--external' : '',
    selected ? 'card--selected' : '',
    hidden ? 'card--hidden' : '',
    highlighted ? 'card--highlight' : '',
    faded ? 'card--faded' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes}>
      <Handle type="target" position={Position.Top} className="card__handle" />

      {/*
        Selection is the card's own job; the two icons are the only things that leave it.
        The body deliberately carries no `nopan`, so a drag that starts on a card still moves the
        canvas — the slop check below is what keeps that drag from also toggling selection.
      */}
      <button
        type="button"
        className="card__body nodrag"
        aria-pressed={selected}
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
          onToggleSelect(node.id)
        }}
      >
        <span className="card__head">
          <span className="card__id">{label}</span>
          <span className="card__state">{STATE_TEXT[node.state]}</span>
        </span>

        <span
          className="card__title"
          style={{ WebkitLineClamp: node.titleLines, lineClamp: node.titleLines }}
        >
          {node.title}
        </span>

        {node.labels.length > 0 && (
          <span className="card__labels">
            {node.labels.map((chip) => (
              <span key={chip.raw} className="chip">
                {chip.namespace ? `${chip.namespace}: ${chip.value}` : chip.value}
              </span>
            ))}
          </span>
        )}
      </button>

      <span className="card__actions nodrag nopan">
        <button
          type="button"
          className="iconbutton"
          aria-label={`Open ${label} on GitHub`}
          data-tip="Open on GitHub"
          onClick={() => onOpen(node.url, `${label} · ${node.title}`)}
        >
          <Icon name="external" size={12} />
        </button>
        <button
          type="button"
          className="iconbutton"
          aria-label={hidden ? `Show ${label}` : `Hide ${label}`}
          aria-pressed={hidden}
          data-tip={hidden ? 'Show this issue' : 'Hide this issue'}
          onClick={() => onToggleHidden(node.id)}
        >
          <Icon name={hidden ? 'eye-off' : 'eye'} size={12} />
        </button>
      </span>

      <Handle type="source" position={Position.Bottom} className="card__handle" />
    </div>
  )
}
