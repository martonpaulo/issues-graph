import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'

import type { GraphNode, IssueState } from './graph'

export type IssueNode = Node<{ node: GraphNode }, 'issue'>

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
  const { node } = data

  return (
    <div className={`card card--${node.state}${node.external ? ' card--external' : ''}`}>
      <Handle type="target" position={Position.Top} className="card__handle" />

      <a
        className="card__link"
        href={node.url}
        target="_blank"
        rel="noopener noreferrer"
        title={node.title}
      >
        <span className="card__head">
          <span className="card__number">
            {node.external ? `${node.repo}#${node.number}` : `#${node.number}`}
          </span>
          <span className="card__state">{STATE_TEXT[node.state]}</span>
        </span>

        <span className="card__title">{node.title}</span>

        {node.labels.length > 0 && (
          <span className="card__labels">
            {node.labels.map((label) => (
              <span key={label.raw} className="chip" title={label.raw}>
                {label.namespace ? `${label.namespace}: ${label.value}` : label.value}
              </span>
            ))}
          </span>
        )}
      </a>

      <Handle type="source" position={Position.Bottom} className="card__handle" />
    </div>
  )
}
