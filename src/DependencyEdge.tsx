import { BaseEdge, type Edge, type EdgeProps } from '@xyflow/react'

import type { Point } from './graph'

/** How far a corner is rounded off: enough to read as a turn, not enough to become a curve. */
export const EDGE_RADIUS = 12

export type DependencyEdgeType = Edge<{ points?: Point[] }, 'dependency'>

/** An SVG path through the points, with each corner rounded to at most `radius`. */
export function roundedPath(points: Point[], radius: number): string {
  if (points.length < 2) return ''

  let path = `M ${points[0].x},${points[0].y}`

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]
    const corner = points[index]
    const next = points[index + 1]

    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y)
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y)
    const r = Math.min(radius, inLength / 2, outLength / 2)
    if (r < 1 || inLength === 0 || outLength === 0) {
      path += ` L ${corner.x},${corner.y}`
      continue
    }

    const start = {
      x: corner.x + ((previous.x - corner.x) / inLength) * r,
      y: corner.y + ((previous.y - corner.y) / inLength) * r,
    }
    const end = {
      x: corner.x + ((next.x - corner.x) / outLength) * r,
      y: corner.y + ((next.y - corner.y) / outLength) * r,
    }
    path += ` L ${start.x},${start.y} Q ${corner.x},${corner.y} ${end.x},${end.y}`
  }

  const last = points[points.length - 1]
  return `${path} L ${last.x},${last.y}`
}

/**
 * A dependency arrow.
 *
 * The route is the one the layout reserved: already orthogonal, already given its own point on
 * each card, and already taken around whatever sits between the two ends. All this draws is the
 * polyline, with the corners rounded off. The straight fallback only exists so an edge whose route
 * went missing is still visible rather than silently absent.
 */
export function DependencyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
}: EdgeProps<DependencyEdgeType>) {
  const points =
    data?.points && data.points.length >= 2
      ? data.points
      : [
          { x: sourceX, y: sourceY },
          { x: targetX, y: targetY },
        ]

  return <BaseEdge id={id} path={roundedPath(points, EDGE_RADIUS)} markerEnd={markerEnd} />
}
