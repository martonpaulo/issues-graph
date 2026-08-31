import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { memo, useId, useRef } from 'react'

import { issueRef } from './dependencies'
import type { GraphNode, IssueState } from './graph'
import { Icon } from './icons'
import { chipPalette } from './labelColor'

export interface IssueCardData extends Record<string, unknown> {
  node: GraphNode
  selected: boolean
  /** Drained of colour and attention, but still on the canvas and still in the reading order. */
  dimmed: boolean
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
  onToggleDimmed: (id: string) => void
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
  // Nobody is on it, which is not the same as free to start: it is unqueued.
  unassigned: 'unassigned',
  blocked: 'blocked',
  'in-progress': 'in progress',
  attention: 'needs attention',
  // The word is "delivered", not "in review", because the reader is asking what to pick up next
  // and picking this one up implements a change that is already written. It also has to stay short
  // enough to share the head row with a parent's progress count on the widest issue number.
  'in-review': 'delivered',
  completed: 'closed',
  'not-planned': 'not planned',
}

function cardClasses(data: IssueCardData): string {
  const { node, selected, dimmed, highlighted, faded } = data

  return [
    'card',
    node.state ? `card--${node.state}` : '',
    node.external ? 'card--external' : '',
    selected ? 'card--selected' : '',
    dimmed ? 'card--dimmed' : '',
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
  descriptionId,
  onSelect,
}: Pick<IssueCardData, 'node' | 'selected' | 'onSelect'> & { descriptionId: string }) {
  const pressedAt = useRef<{ x: number; y: number } | null>(null)

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
        {/* A parent's own progress, in words: colour says nothing a count can. */}
        {node.subIssues && (
          <span className="card__progress">
            {node.subIssues.completed} of {node.subIssues.total} done
          </span>
        )}
        {node.state && <span className="card__state">{STATE_TEXT[node.state]}</span>}
      </span>

      <span
        className="card__title"
        style={{ WebkitLineClamp: node.titleLines, lineClamp: node.titleLines }}
      >
        {node.title}
      </span>

      <span className="card__labels">
        {/* An empty slot is keyed by its namespace and a real label by its own name, which a
            repository cannot repeat on one issue. Keying on the text alone would collide where a
            repository has a bare `effort` label and the card also draws an outlined `effort`. */}
        {node.labels.map((chip) => {
          /* The repository's own colour is what tells one arbitrary label from another, so the
             chip is painted in the pair derived from it. A label whose payload carries no usable
             hex falls back to the stylesheet's chip, which is held at AA over every card fill. */
          const palette = chip.color === null ? null : chipPalette(chip.color)
          return (
            <span
              key={`${chip.namespace ?? ''}:${chip.text}`}
              className={`chip${chip.empty ? ' chip--empty' : ''}${palette ? ' chip--painted' : ''}`}
              style={
                palette
                  ? {
                      background: palette.background,
                      color: palette.foreground,
                      borderColor: palette.border,
                    }
                  : undefined
              }
            >
              {chip.text}
            </span>
          )
        })}
      </span>
    </button>
  )
}

/** The two controls that act on the issue itself rather than on the selection. */
function CardActions({
  node,
  label,
  dimmed,
  onToggleDimmed,
  onOpen,
}: Pick<IssueCardData, 'node' | 'dimmed' | 'onToggleDimmed' | 'onOpen'> & { label: string }) {
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
        aria-label={dimmed ? `Restore ${label}` : `Dim ${label}`}
        aria-pressed={dimmed}
        data-tip={dimmed ? 'Restore this issue · R' : 'Dim this issue · D'}
        onClick={() => onToggleDimmed(node.id)}
      >
        <Icon name={dimmed ? 'eye-off' : 'eye'} size={12} />
      </button>
    </span>
  )
}

/**
 * One card. Memoized because the canvas rebuilds its node list on every selection, dimming and
 * highlight change: `reuse` keeps the `data` object of an untouched card identical across those
 * rebuilds, and this is what turns that identity into a skipped render rather than an identical
 * one recomputed.
 */
export const IssueCard = memo(function IssueCard({ data }: NodeProps<IssueNode>) {
  const { node, selected, dimmed, description, onSelect, onToggleDimmed, onOpen } = data
  const label = issueRef(node)
  /**
   * React's own per-instance id rather than one spelled out of `node.id`.
   *
   * The node id carries `/` and `#`, and any scheme that folds those into a safe character stops
   * being injective: `acme/foo-bar#1` and `acme-foo/bar#1` are both identities GitHub can produce
   * and both collapse to the same string. Two cards sharing a DOM id is not a cosmetic fault —
   * `aria-describedby` resolves to whichever came first, so one card would be described by the
   * other card's blockers.
   */
  const descriptionId = useId()

  return (
    <div className={cardClasses(data)}>
      <Handle type="target" position={Position.Top} className="card__handle" />

      <CardBody
        node={node}
        selected={selected}
        descriptionId={descriptionId}
        onSelect={onSelect}
      />

      {/* The arrows are geometry, and geometry is exactly what a screen reader cannot follow, so
          the same fact is written out. Deliberately a sibling of the button rather than a child:
          `.sr-only` is clipped from view but stays in the accessibility tree, and a button's name
          is computed from its contents, so inside the button this sentence would land in the name
          as well as in the description and be announced twice. */}
      <span className="sr-only" id={descriptionId}>
        {description}
      </span>

      <CardActions
        node={node}
        label={label}
        dimmed={dimmed}
        onToggleDimmed={onToggleDimmed}
        onOpen={onOpen}
      />

      <Handle type="source" position={Position.Bottom} className="card__handle" />
    </div>
  )
})
