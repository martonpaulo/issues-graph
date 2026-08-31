import type { Node, NodeProps } from '@xyflow/react'
import { memo } from 'react'

import type { GraphGroup } from './graph'

export interface GroupFrameData extends Record<string, unknown> {
  group: GraphGroup
  selected: boolean
  onSelect: (members: string[]) => void
}

/**
 * The node type is `frame`, not `group`: React Flow ships a built-in `group` type whose default
 * stylesheet draws a dark 1px border, and a custom type of that name inherits it.
 */
export type GroupNode = Node<GroupFrameData, 'frame'>

/**
 * The frame behind a set of cards. It is a node so React Flow pans and zooms it with everything
 * else; it sits at a negative z-index so edges and cards draw over it.
 */
export const GroupFrame = memo(function GroupFrame({ data }: NodeProps<GroupNode>) {
  const { group, selected, onSelect } = data

  return (
    <div className={`group group--${group.kind}${selected ? ' group--selected' : ''}`}>
      <button
        type="button"
        className="group__label nodrag nopan"
        aria-pressed={selected}
        onClick={() => onSelect(group.members)}
      >
        {group.label}
      </button>
    </div>
  )
})
