import { describe, expect, it } from 'vitest'

import { roundedPath } from './DependencyEdge'

describe('roundedPath', () => {
  it('draws nothing for a route that cannot form a segment', () => {
    expect(roundedPath([], 12)).toBe('')
    expect(roundedPath([{ x: 10, y: 20 }], 12)).toBe('')
  })

  it('draws a straight line between two points', () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }], 12)).toBe('M 0,0 L 100,0')
  })

  it('pulls a corner back by the radius along each leg and curves through it', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]

    expect(roundedPath(route, 12)).toBe('M 0,0 L 88,0 Q 100,0 100,12 L 100,100')
  })

  it('clamps the radius to half of the shorter leg', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]

    // Both legs are 10 long, so the corner rounds by 5 rather than the requested 12: adjacent
    // corners would otherwise consume the same stretch of line and overlap.
    expect(roundedPath(route, 12)).toBe('M 0,0 L 5,0 Q 10,0 10,5 L 10,10')
  })

  it('leaves a corner square when the clamped radius falls below a pixel', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]

    expect(roundedPath(route, 12)).toBe('M 0,0 L 1,0 L 1,1')
  })

  it('survives a repeated point instead of dividing by its zero-length leg', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]

    const path = roundedPath(route, 12)

    expect(path).toBe('M 0,0 L 0,0 L 100,0')
    expect(path).not.toContain('NaN')
  })

  it('rounds every interior corner of a longer route and leaves the ends alone', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ]

    expect(roundedPath(route, 12)).toBe(
      'M 0,0 L 88,0 Q 100,0 100,12 L 100,88 Q 100,100 112,100 L 200,100',
    )
  })
})
