import { describe, expect, it } from 'vitest'

import { arrowHead, roundedPath } from './DependencyEdge'

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

describe('arrowHead', () => {
  it('points the way the last leg arrives and sits on its final point', () => {
    // Arriving upwards: the tip is the end point and the base is below it.
    expect(arrowHead([{ x: 50, y: 100 }, { x: 50, y: 20 }])).toBe(
      'M 50,20 L 54.5,29 L 45.5,29 Z',
    )
  })

  it('turns with the leg rather than always pointing one way', () => {
    // Arriving rightwards: the same triangle, rotated a quarter turn.
    expect(arrowHead([{ x: 0, y: 0 }, { x: 80, y: 0 }])).toBe('M 80,0 L 71,4.5 L 71,-4.5 Z')
  })

  it('reads the direction from the last leg of a turning route', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 0, y: 60 },
      { x: 40, y: 60 },
    ]

    expect(arrowHead(route)).toBe('M 40,60 L 31,64.5 L 31,55.5 Z')
  })

  it('skips back past a repeated end point instead of dividing by a zero-length leg', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 0, y: 60 },
      { x: 0, y: 60 },
    ]

    expect(arrowHead(route)).toBe('M 0,60 L -4.5,51 L 4.5,51 Z')
  })

  it('draws nothing when the whole route sits on one point', () => {
    expect(arrowHead([{ x: 7, y: 7 }, { x: 7, y: 7 }])).toBe('')
  })
})
