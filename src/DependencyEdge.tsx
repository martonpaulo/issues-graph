import { BaseEdge, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react'

import type { Point } from './graph'

/** Orthogonal segments with rounded corners: a route the eye can follow, not a loose curve. */
export const EDGE_RADIUS = 12

export type DependencyEdgeType = Edge<{ centerY?: number; points?: Point[] }, 'dependency'>

/**
 * Turns waypoints into an orthogonal route: down, across, down again.
 *
 * dagre's own points are a slanted polyline through the space it reserved between cards. Keeping
 * the x of each one and travelling between them at right angles gives a path that stays inside
 * that reserved space while reading as a diagram rather than as a thread.
 */
function orthogonalise(points: Point[]): Point[] {
  const route: Point[] = [points[0]]

  for (let index = 1; index < points.length; index += 1) {
    const from = route[route.length - 1]
    const to = points[index]
    if (Math.abs(from.x - to.x) > 0.5) {
      const turn = (from.y + to.y) / 2
      route.push({ x: from.x, y: turn }, { x: to.x, y: turn })
    }
    route.push(to)
  }

  // Drop anything that does not change direction; a corner radius needs real corners.
  return route.filter((point, index) => {
    if (index === 0 || index === route.length - 1) return true
    const previous = route[index - 1]
    const next = route[index + 1]
    const straightX = Math.abs(previous.x - point.x) < 0.5 && Math.abs(point.x - next.x) < 0.5
    const straightY = Math.abs(previous.y - point.y) < 0.5 && Math.abs(point.y - next.y) < 0.5
    return !(straightX || straightY)
  })
}

/** An SVG path through the points, with each corner rounded to at most `radius`. */
function roundedPath(points: Point[], radius: number): string {
  if (points.length < 2) return ''

  let path = `M ${points[0].x},${points[0].y}`

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]
    const corner = points[index]
    const next = points[index + 1]

    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y)
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y)
    const r = Math.min(radius, inLength / 2, outLength / 2)
    if (r < 1) {
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
 * React Flow's own smoothstep always turns at the midpoint between two cards, so every edge
 * arriving at one row runs along the same line and they merge into one, and an edge spanning
 * several ranks cuts straight through whatever sits between them. `graph.ts` gives each edge either
 * a channel to turn in or the waypoints to follow; this edge honours whichever it got.
 */
export function DependencyEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<DependencyEdgeType>) {
  if (data?.points && data.points.length > 2) {
    // The ends come from the handles, which is where the arrow has to start and stop; the middle
    // waypoints are dagre's.
    const waypoints = [
      { x: sourceX, y: sourceY },
      ...data.points.slice(1, -1),
      { x: targetX, y: targetY },
    ]
    return <BaseEdge id={id} path={roundedPath(orthogonalise(waypoints), EDGE_RADIUS)} markerEnd={markerEnd} />
  }

  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: EDGE_RADIUS,
    centerY: data?.centerY,
  })

  return <BaseEdge id={id} path={path} markerEnd={markerEnd} />
}
