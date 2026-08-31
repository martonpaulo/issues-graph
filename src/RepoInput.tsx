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
/** The blur has to outlive the click that caused it, or the option is gone before it can be chosen. */
const BLUR_GRACE_MS = 120

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
 * The open/closed and highlighted-option state of the listbox, with the keyboard contract a
 * combobox owes: arrows wrap through the options, Escape closes without choosing, and the close
 * on blur is delayed so a click on an option still lands.
 */
function useComboboxNavigation(count: number) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const blurTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(blurTimer.current), [])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown' && count > 0) {
        event.preventDefault()
        setOpen(true)
        setActive((index) => (index + 1) % count)
      } else if (event.key === 'ArrowUp' && count > 0) {
        event.preventDefault()
        setOpen(true)
        setActive((index) => (index <= 0 ? count - 1 : index - 1))
      } else if (event.key === 'Escape') {
        setOpen(false)
        setActive(-1)
      }
    },
    [count],
  )

  const show = useCallback(() => setOpen(true), [])
  const close = useCallback(() => setOpen(false), [])
  const reset = useCallback(() => setActive(-1), [])
  const onBlur = useCallback(() => {
    blurTimer.current = window.setTimeout(() => setOpen(false), BLUR_GRACE_MS)
  }, [])

  const visible = open && count > 0

  return {
    active,
    visible,
    /** The option a submit would take, or -1 when the typed text stands on its own. */
    chosen: visible && active >= 0 ? active : -1,
    setActive,
    show,
    close,
    reset,
    onKeyDown,
    onBlur,
  }
}

function SuggestionList({
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
        <li key={slug} id={`${listId}-${index}`} role="option" aria-selected={index === active}>
          <button
            type="button"
            className={`repoinput__option${index === active ? ' is-active' : ''}`}
            onMouseEnter={() => onHover(index)}
            onClick={() => onChoose(slug)}
          >
            {slug}
          </button>
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

  const typed = value.trim()
  // Opening the repository already open does nothing, so the control that would do it is off.
  const unchanged = initial.length > 0 && typed.toLowerCase() === initial.toLowerCase()

  const suggestions = useRepoSuggestions(typed, token)
  const list = useComboboxNavigation(suggestions.length)

  const submit = useCallback(
    (raw: string) => {
      const target = parseTargetInput(raw)
      if (!target) {
        setError('Name the repository as owner/repo — the owner is never assumed.')
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
            className="repoinput__input"
            value={value}
            placeholder="owner/repo"
            aria-label="Repository, as owner/repo"
            role="combobox"
            aria-expanded={list.visible}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={list.active >= 0 ? `${listId}-${list.active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            autoFocus={initial.length === 0}
            onChange={(event) => {
              setValue(event.target.value)
              list.reset()
              list.show()
            }}
            onFocus={list.show}
            onBlur={list.onBlur}
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

      {error && <p className="notice notice--error">{error}</p>}
    </div>
  )
}
