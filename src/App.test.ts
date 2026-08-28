import { describe, expect, it } from 'vitest'

import { nextIssueSelection } from './App'

describe('nextIssueSelection', () => {
  it('replaces the selection for an ordinary issue click', () => {
    expect([...nextIssueSelection(new Set(['1', '2']), '3', false)]).toEqual(['3'])
    expect([...nextIssueSelection(new Set(['1', '2']), '2', false)]).toEqual(['2'])
  })

  it('toggles one issue for a modified click', () => {
    expect([...nextIssueSelection(new Set(['1']), '2', true)]).toEqual(['1', '2'])
    expect([...nextIssueSelection(new Set(['1', '2']), '2', true)]).toEqual(['1'])
  })
})
