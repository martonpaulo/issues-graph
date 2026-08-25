import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { searchRepositories } from './github'
import { Icon } from './icons'
import { parseTargetInput, slugOf, type RepoTarget } from './route'
import { readStored, writeStored } from './storage'

const RECENT_KEY = 'issue-graph:recent'
const RECENT_LIMIT = 6
/** Long enough that a word typed at speed costs one search, not one per keystroke. */
const DEBOUNCE_MS = 350

export function recentTargets(): string[] {
  return readStored<string[]>(RECENT_KEY, []).filter((slug) => parseTargetInput(slug) !== null)
}

export function rememberTarget(target: RepoTarget): void {
  const slug = slugOf(target)
  const next = [slug, ...recentTargets().filter((entry) => entry !== slug)].slice(0, RECENT_LIMIT)
  writeStored(RECENT_KEY, next)
}

/**
 * A combobox over two sources: repositories opened before, which cost nothing to offer, and live
 * GitHub search. Typed text always wins — a suggestion is never required to submit.
 */
export function RepoInput({
  initial = '',
  onOpen,
}: {
  initial?: string
  onOpen: (target: RepoTarget) => void
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  // Keyed by the query it answered, so a stale result is simply not used and nothing has to be
  // cleared on every keystroke.
  const [found, setFound] = useState<{ query: string; slugs: string[] }>({ query: '', slugs: [] })
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()
  const blurTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(blurTimer.current), [])

  const typed = value.trim()
  // Opening the repository already open does nothing, so the control that would do it is off.
  const unchanged = initial.length > 0 && typed.toLowerCase() === initial.toLowerCase()

  const suggestions = useMemo(() => {
    const merged = recentTargets().filter((slug) =>
      typed.length === 0 ? true : slug.toLowerCase().includes(typed.toLowerCase()),
    )
    if (found.query === typed) {
      for (const slug of found.slugs) if (!merged.includes(slug)) merged.push(slug)
    }
    return merged.slice(0, 8)
  }, [typed, found])

  useEffect(() => {
    if (typed.length < 2) return

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void searchRepositories(typed, { signal: controller.signal }).then((slugs) => {
        if (!controller.signal.aborted) setFound({ query: typed, slugs })
      })
    }, DEBOUNCE_MS)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [typed])

  const submit = useCallback(
    (raw: string) => {
      const target = parseTargetInput(raw)
      if (!target) {
        setError('Name the repository as owner/repo — the owner is never assumed.')
        return
      }
      setError(null)
      setOpen(false)
      onOpen(target)
    },
    [onOpen],
  )

  const visible = open && suggestions.length > 0

  return (
    <div className="repoinput">
      <form
        className="repoinput__form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          if (unchanged && !(active >= 0 && visible)) return
          submit(active >= 0 && visible ? suggestions[active] : value)
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
            aria-expanded={visible}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            autoFocus={initial.length === 0}
            onChange={(event) => {
              setValue(event.target.value)
              setActive(-1)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            // The blur has to outlive the click that caused it, or the option is gone before it
            // can be chosen.
            onBlur={() => {
              blurTimer.current = window.setTimeout(() => setOpen(false), 120)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && suggestions.length > 0) {
                event.preventDefault()
                setOpen(true)
                setActive((index) => (index + 1) % suggestions.length)
              } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
                event.preventDefault()
                setOpen(true)
                setActive((index) => (index <= 0 ? suggestions.length - 1 : index - 1))
              } else if (event.key === 'Escape') {
                setOpen(false)
                setActive(-1)
              }
            }}
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

      {visible && (
        <ul className="repoinput__list" id={listId} role="listbox" aria-label="Repository suggestions">
          {suggestions.map((slug, index) => (
            <li key={slug} id={`${listId}-${index}`} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={`repoinput__option${index === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  setValue(slug)
                  submit(slug)
                }}
              >
                {slug}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="notice notice--error">{error}</p>}
    </div>
  )
}
