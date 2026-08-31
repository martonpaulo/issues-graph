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
})
