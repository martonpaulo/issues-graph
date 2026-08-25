import type { Node, NodeProps } from '@xyflow/react'

import type { GraphGroup } from './graph'

export interface GroupFrameData extends Record<string, unknown> {
  group: GraphGroup
  selected: boolean
  onSelect: (members: string[]) => void
}

export type GroupNode = Node<GroupFrameData, 'group'>

/**
 * The frame behind a set of cards. It is a node so React Flow pans and zooms it with everything
 * else; it sits at a negative z-index so edges and cards draw over it.
 */
export function GroupFrame({ data }: NodeProps<GroupNode>) {
  const { group, selected, onSelect } = data

  return (
    <div className={`group group--${group.kind}${selected ? ' group--selected' : ''}`}>
      <button
        type="button"
        className="group__label nodrag nopan"
        aria-pressed={selected}
        data-tip="Select every issue in this group"
        onClick={() => onSelect(group.members)}
      >
        {group.label}
      </button>
    </div>
  )
}
