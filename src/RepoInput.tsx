import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'

import { searchRepositories } from './github'
import { Icon } from './icons'
import { parseTargetInput, type RepoTarget } from './route'
import { mergeSuggestions } from './suggestions'

/** Long enough that a word typed at speed costs one search, not one per keystroke. */
const DEBOUNCE_MS = 350

/** The one wording of the failure, so the message and the test that reads it cannot drift apart. */
export const INVALID_TARGET = 'Name the repository as owner/repo — the owner is never assumed.'

/**
 * What a validation failure adds to the input: the invalid state, and the description that says
 * why. Both are absent while the value is acceptable, so a corrected value leaves nothing behind
 * for a screen reader to announce.
 */
export function describeValidation(
  error: string | null,
  errorId: string,
): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
  return error ? { 'aria-invalid': true, 'aria-describedby': errorId } : {}
}

/**
 * The two suggestion sources merged for the text currently typed: repositories opened before, and
 * live GitHub search, debounced and abandoned as soon as the text moves on.
 */
function useRepoSuggestions(typed: string, token: string): string[] {
  // Keyed by the query it answered, so a stale result is simply not used and nothing has to be
  // cleared on every keystroke.
  const [found, setFound] = useState<{ query: string; slugs: string[] }>({ query: '', slugs: [] })

  useEffect(() => {
    if (typed.length < 2) return

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void searchRepositories(typed, { signal: controller.signal, token }).then((slugs) => {
        if (!controller.signal.aborted) setFound({ query: typed, slugs })
      })
    }, DEBOUNCE_MS)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [typed, token])

  return useMemo(
    () => mergeSuggestions(typed, found.query === typed ? found.slugs : []),
    [typed, found],
  )
}

/**
 * Where a key press leaves the highlighted option: the arrows wrap in both directions, Escape
 * gives up the highlight, and every other key leaves it alone. `null` means the key was not one
 * the listbox owns, so the event keeps its default behavior.
 */
export function nextActiveOption(
  key: string,
  active: number,
  count: number,
): number | null {
  if (key === 'Escape') return -1
  if (count === 0) return null
  if (key === 'ArrowDown') return (active + 1) % count
  if (key === 'ArrowUp') return active <= 0 ? count - 1 : active - 1
  return null
}

/**
 * The option a submit would take, or -1 when the typed text stands on its own.
 *
 * Deliberately blind to whether the popup is on screen. Pressing the `Open` button blurs the input,
 * which closes the popup in the render *before* the submit event arrives, so a choice derived from
 * visibility would be thrown away by the very click meant to act on it. Only giving up the
 * highlight — Escape, typing, or choosing — gives up the choice. An index past the end is one whose
 * suggestion list moved under it, which is no choice either.
 */
export function chosenSuggestion(active: number, count: number): number {
  return active >= 0 && active < count ? active : -1
}

/**
 * The open/closed and highlighted-option state of the listbox, with the keyboard contract a
 * combobox owes: arrows wrap through the options and Escape closes without choosing. Focus never
 * leaves the input for a press on an option, so the popup cannot close before that click lands.
 */
function useComboboxNavigation(count: number) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      const next = nextActiveOption(event.key, active, count)
      if (next === null) return

      if (event.key === 'Escape') {
        setOpen(false)
      } else {
        event.preventDefault()
        setOpen(true)
      }
      setActive(next)
    },
    [active, count],
  )

  const show = useCallback(() => setOpen(true), [])
  const close = useCallback(() => setOpen(false), [])
  const reset = useCallback(() => setActive(-1), [])

  const visible = open && count > 0

  return {
    active,
    visible,
    chosen: chosenSuggestion(active, count),
    setActive,
    show,
    close,
    reset,
    onKeyDown,
  }
}

export function SuggestionList({
  listId,
  suggestions,
  active,
  onHover,
  onChoose,
}: {
  listId: string
  suggestions: string[]
  active: number
  onHover: (index: number) => void
  onChoose: (slug: string) => void
}) {
  return (
    <ul className="repoinput__list" id={listId} role="listbox" aria-label="Repository suggestions">
      {suggestions.map((slug, index) => (
        // The option is the whole list item: a focusable descendant would be a second widget
        // inside a role the listbox pattern reserves for one.
        // https://www.w3.org/WAI/ARIA/apg/patterns/listbox/
        <li
          key={slug}
          id={`${listId}-${index}`}
          role="option"
          aria-selected={index === active}
          className={`repoinput__option${index === active ? ' is-active' : ''}`}
          // Keeping the press from reaching the document is what keeps focus on the input, so the
          // option is still mounted when the click arrives and no timer has to outlive a blur.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onChoose(slug)}
        >
          {slug}
        </li>
      ))}
    </ul>
  )
}

/**
 * A combobox over two sources: repositories opened before, which cost nothing to offer, and live
 * GitHub search. Typed text always wins — a suggestion is never required to submit.
 */
export function RepoInput({
  initial = '',
  onOpen,
  token = '',
}: {
  initial?: string
  onOpen: (target: RepoTarget) => void
  /** Search has its own budget, and a token raises that one too. */
  token?: string
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const listId = useId()
  const errorId = `${listId}-error`
  const inputRef = useRef<HTMLInputElement>(null)

  const typed = value.trim()
  // Opening the repository already open does nothing, so the control that would do it is off.
  const unchanged = initial.length > 0 && typed.toLowerCase() === initial.toLowerCase()

  const suggestions = useRepoSuggestions(typed, token)
  const list = useComboboxNavigation(suggestions.length)

  const submit = useCallback(
    (raw: string) => {
      const target = parseTargetInput(raw)
      if (!target) {
        setError(INVALID_TARGET)
        // The message describes the input, so the input is where the reading has to be, whether
        // the submit came from the button or from Enter.
        inputRef.current?.focus()
        return
      }
      setError(null)
      list.close()
      onOpen(target)
    },
    [list, onOpen],
  )

  return (
    <div className="repoinput">
      <form
        className="repoinput__form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          if (unchanged && list.chosen < 0) return
          submit(list.chosen >= 0 ? suggestions[list.chosen] : value)
        }}
      >
        <label className="repoinput__field">
          <Icon name="search" />
          <input
            ref={inputRef}
            className="repoinput__input"
            value={value}
            placeholder="owner/repo"
            aria-label="Repository, as owner/repo"
            role="combobox"
            aria-expanded={list.visible}
            aria-controls={listId}
            aria-autocomplete="list"
            // Only while the options are on screen: the highlight outlives the popup so a submit
            // can still act on it, but an id that is no longer rendered is not something to point
            // a screen reader at.
            aria-activedescendant={
              list.visible && list.active >= 0 ? `${listId}-${list.active}` : undefined
            }
            {...describeValidation(error, errorId)}
            autoComplete="off"
            spellCheck={false}
            autoFocus={initial.length === 0}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
              list.reset()
              list.show()
            }}
            onFocus={list.show}
            onBlur={list.close}
            onKeyDown={list.onKeyDown}
          />
        </label>
        <button
          className="button button--primary"
          type="submit"
          disabled={typed.length === 0 || unchanged}
        >
          Open
        </button>
      </form>

      {list.visible && (
        <SuggestionList
          listId={listId}
          suggestions={suggestions}
          active={list.active}
          onHover={list.setActive}
          onChoose={(slug) => {
            setValue(slug)
            submit(slug)
          }}
        />
      )}

      {error && (
        <p className="notice notice--error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
