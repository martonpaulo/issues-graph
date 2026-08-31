import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  describeValidation,
  INVALID_TARGET,
  nextActiveOption,
  RepoInput,
  SuggestionList,
} from './RepoInput'

function renderList(suggestions: string[], active: number): string {
  return renderToStaticMarkup(
    createElement(SuggestionList, {
      listId: 'repo',
      suggestions,
      active,
      onHover: () => {},
      onChoose: () => {},
    }),
  )
}

describe('nextActiveOption', () => {
  it('wraps forward through the options', () => {
    expect(nextActiveOption('ArrowDown', -1, 3)).toBe(0)
    expect(nextActiveOption('ArrowDown', 2, 3)).toBe(0)
  })

  it('wraps backward through the options', () => {
    expect(nextActiveOption('ArrowUp', -1, 3)).toBe(2)
    expect(nextActiveOption('ArrowUp', 0, 3)).toBe(2)
    expect(nextActiveOption('ArrowUp', 2, 3)).toBe(1)
  })

  it('gives up the highlight on Escape, even with nothing to highlight', () => {
    expect(nextActiveOption('Escape', 1, 3)).toBe(-1)
    expect(nextActiveOption('Escape', -1, 0)).toBe(-1)
  })

  it('leaves an empty list and unrelated keys alone', () => {
    expect(nextActiveOption('ArrowDown', -1, 0)).toBeNull()
    expect(nextActiveOption('ArrowUp', -1, 0)).toBeNull()
    expect(nextActiveOption('Enter', 1, 3)).toBeNull()
    expect(nextActiveOption('a', 1, 3)).toBeNull()
  })
})

describe('describeValidation', () => {
  it('marks the input invalid and points it at the message', () => {
    expect(describeValidation(INVALID_TARGET, 'repo-error')).toEqual({
      'aria-invalid': true,
      'aria-describedby': 'repo-error',
    })
  })

  it('leaves nothing behind once the value is acceptable', () => {
    expect(describeValidation(null, 'repo-error')).toEqual({})
  })

  it('names the owner requirement in full', () => {
    expect(INVALID_TARGET).toBe('Name the repository as owner/repo — the owner is never assumed.')
  })
})

describe('SuggestionList', () => {
  it('gives each suggestion one option semantic with no interactive descendant', () => {
    const markup = renderList(['acme/app', 'acme/tools'], -1)

    expect(markup).toContain('<li id="repo-0" role="option" aria-selected="false"')
    expect(markup).toContain('<li id="repo-1" role="option" aria-selected="false"')
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('href')
    expect(markup).not.toContain('tabindex')
  })

  it('marks the highlighted option, and only that one, as selected', () => {
    const markup = renderList(['acme/app', 'acme/tools'], 1)

    expect(markup).toContain('<li id="repo-0" role="option" aria-selected="false"')
    expect(markup).toContain('<li id="repo-1" role="option" aria-selected="true"')
    expect(markup).toContain('is-active')
  })
})

describe('RepoInput', () => {
  it('describes the input as a combobox and claims nothing invalid before a submit', () => {
    const markup = renderToStaticMarkup(
      createElement(RepoInput, { initial: 'acme/app', onOpen: () => {} }),
    )

    expect(markup).toContain('role="combobox"')
    expect(markup).toContain('aria-autocomplete="list"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('aria-invalid')
    expect(markup).not.toContain('aria-describedby')
    expect(markup).not.toContain(INVALID_TARGET)
  })
})
