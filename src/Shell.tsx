/**
 * The page every route shares: the heading, the repository field, the token field, the
 * confirmation shown before leaving for GitHub, and the keyboard lifecycle every overlay obeys.
 *
 * It lives apart from both routes because both need it. The landing route is the whole page here,
 * and the repository route reuses it for everything it has to say before a graph exists — which is
 * also what lets the graph runtime load lazily without the shell disappearing while it arrives.
 * The overlay hooks are here for the same reason: the confirmation dialog on this side and the
 * canvas's dialogs and pickers on the other are the same lifecycle, and one owner is what keeps
 * them from drifting apart.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from 'react'

import { AUTHENTICATED_HOURLY_LIMIT, UNAUTHENTICATED_HOURLY_LIMIT } from './github'
import { Icon } from './icons'
import { RepoInput } from './RepoInput'
import type { RepoTarget } from './route'

/** Project sites are served from `/<repository>/`, so every in-app path carries that prefix. */
export const BASE = import.meta.env.BASE_URL

/* External navigation ------------------------------------------------------
   Every link out of the viewer is confirmed, so a click on a card never moves
   the page somewhere the reader did not choose to go. */

export interface PendingLink {
  url: string
  label: string
}

export const OpenExternalContext = createContext<(url: string, label: string) => void>(() => {})

/* The viewer's token ------------------------------------------------------
   Shared the same way, because the shell, the repository field and the load
   all need it and none of them owns it. */

export interface TokenState {
  token: string
  /** Stores and applies the value; blank removes it. Takes effect on the next request. */
  setToken: (value: string) => void
}

export const TokenContext = createContext<TokenState>({ token: '', setToken: () => {} })

export function useTokenState(): TokenState {
  return useContext(TokenContext)
}

export function useOpenExternal(): (url: string, label: string) => void {
  return useContext(OpenExternalContext)
}

/* Overlay keyboard lifecycle ----------------------------------------------
   Two kinds of surface sit over the page: a modal dialog, which owns the whole
   window while it is open, and a panel hanging off the button that opened it.
   Both are reached from a control the reader has to be given back afterwards.
   What a key asks of them is a pure function, exercised without a browser; the
   effects below only carry the answer out. */

/** What a key press asks of an open overlay. */
export type OverlayAction = 'close' | 'focus-next' | 'focus-previous'

/**
 * What a key press asks of an open overlay: dismiss it, or move to the control before or after
 * the one that has the focus.
 *
 * Pure, and separate from the effects that run it, so the whole table — including every
 * combination an overlay must decline — is exercised without a browser. A chord belongs to the
 * browser rather than to the page, so only a bare Tab and Shift+Tab are read here.
 * https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
 */
export function overlayKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): OverlayAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Tab') return event.shiftKey ? 'focus-previous' : 'focus-next'
  return null
}

/**
 * Where Tab goes next inside a trap of `count` controls, from the one at `current`.
 *
 * The whole cycle is computed rather than only its two ends, so a press is answered the same way
 * wherever it comes from — including from outside the trap, which is what a `current` of `-1`
 * means and what the browser reports while the focus is still on `<body>`.
 */
export function nextTrapIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1
  if (current < 0 || current >= count) return backwards ? count - 1 : 0
  return (current + (backwards ? -1 : 1) + count) % count
}

/**
 * How a control declares the panel it opens.
 *
 * `aria-controls` names the panel only while it is open, because the panel is mounted only while
 * it is open and a reference to an absent element tells a screen reader nothing.
 * https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/
 */
export function popupTriggerProps(open: boolean, panelId: string) {
  return {
    'aria-haspopup': 'dialog' as const,
    'aria-expanded': open,
    'aria-controls': open ? panelId : undefined,
  }
}

/**
 * Whether the trigger takes the focus back after a press outside an open panel.
 *
 * Two ways to lose a reader's place, and they pull in opposite directions. Pulling the focus back
 * from a control they just pressed puts them somewhere they did not ask to be; leaving it where a
 * closing panel dropped it — `<body>`, because the canvas and the page behind it take no focus —
 * strands them at the top of the document, which is the fault this whole change is about. So the
 * trigger takes it back only when the reader was standing inside the panel and the press landed on
 * nothing that could hold the focus instead.
 */
export function restoresTriggerAfterOutsidePress(
  focusWasInsidePanel: boolean,
  focusLandedOnAControl: boolean,
): boolean {
  return focusWasInsidePanel && !focusLandedOnAControl
}

/**
 * One deferred call that outlives whatever scheduled it, until it is cancelled outright.
 *
 * The popover below needs a call that runs *after* a press has finished being one, scheduled by
 * the very close that ends the state the press was in. Owning that timer alongside the open state
 * cancels it on the transition that scheduled it, which is the restoration silently never
 * happening; owning it here means only `cancel` stops it, and only the hook unmounting calls that.
 */
export function createSettler() {
  let pending: ReturnType<typeof setTimeout> | null = null
  return {
    /** Runs `task` once the current turn is over, replacing any call still waiting. */
    after(task: () => void) {
      if (pending !== null) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        task()
      })
    },
    cancel() {
      if (pending !== null) clearTimeout(pending)
      pending = null
    },
  }
}

/** The controls a reader can reach with Tab, in the order Tab reaches them. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]'

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.tabIndex >= 0,
  )
}

/**
 * Everything outside `element` made unreachable, and the call that puts it back.
 *
 * Walking up from the overlay and inerting every sibling on the way leaves exactly its own
 * ancestors reachable, which is what `aria-modal` already promises a screen reader and what the
 * pointer and Tab have to be held to as well. It starts from the element rather than from a known
 * root because the two dialogs are mounted in different places: one beside the route, the other
 * inside the canvas.
 * https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/inert
 */
function inertOutside(element: HTMLElement): () => void {
  const inerted: HTMLElement[] = []
  for (let node = element; node !== document.body && node.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert) continue
      sibling.inert = true
      inerted.push(sibling)
    }
  }
  return () => {
    for (const node of inerted) node.inert = false
  }
}

/**
 * The keyboard lifecycle of a modal dialog: the opener is remembered, the focus moves to the
 * control the dialog wants answered first, Tab and Shift+Tab cycle inside it, the rest of the
 * page is inert, and the opener gets the focus back however the dialog is closed.
 *
 * `initialRef` is the caller's choice of first control, so the dialog names it rather than
 * inheriting whatever happens to be first in the markup.
 */
export function useModalDialog<Initial extends HTMLElement>(onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const initialRef = useRef<Initial>(null)

  // The handler is read as an effect event so the effect below runs once per opening. It moves the
  // focus and inerts the page, and a caller passing a fresh closure on every render would
  // otherwise have all of that torn down and redone under the reader's hands.
  // https://react.dev/reference/react/useEffectEvent
  const close = useEffectEvent(onClose)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const opener = document.activeElement as HTMLElement | null
    ;(initialRef.current ?? focusableWithin(dialog)[0])?.focus()
    const restoreBackground = inertOutside(dialog)

    const onKey = (event: KeyboardEvent) => {
      const action = overlayKeyAction(event)
      if (action === null) return
      if (action === 'close') {
        event.preventDefault()
        close()
        return
      }
      const controls = focusableWithin(dialog)
      const from = controls.indexOf(document.activeElement as HTMLElement)
      const next = nextTrapIndex(controls.length, from, action === 'focus-previous')
      if (next < 0) return
      event.preventDefault()
      controls[next].focus()
    }

    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      restoreBackground()
      // Back where the reader was standing. The opener can be gone by now — a card is removed
      // when the graph is reloaded under the dialog — and `isConnected` is what says so.
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  return { dialogRef, initialRef }
}

/**
 * The keyboard lifecycle of a panel hanging off a button: Escape closes it, a press anywhere
 * outside closes it, and the button takes the focus back whenever the panel would otherwise have
 * left the reader with nowhere to stand.
 *
 * The focus is not moved on opening. The panel is rendered immediately after its button, so Tab
 * already walks into it, and forcing the focus would change what a pointer does as well.
 */
export function usePopover(open: boolean, onClose: () => void) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // One settler for the life of the picker, through `useState`'s lazy initializer so it is built
  // once rather than on every render.
  const [settling] = useState(createSettler)

  /**
   * Closing from a key: the reader is inside the panel, or on `<body>` because something already
   * took the panel away, and either way the trigger is where they came from.
   */
  const restoreTrigger = useCallback(() => {
    const active = document.activeElement
    if (active === document.body || panelRef.current?.contains(active)) triggerRef.current?.focus()
  }, [])

  /** Closing from inside the panel — its own close button, or Escape. */
  const dismiss = useCallback(() => {
    onClose()
    restoreTrigger()
  }, [onClose, restoreTrigger])

  // The two handlers below are read as effect events, so the listeners are subscribed once per
  // opening rather than resubscribed on every render.
  const dismissEvent = useEffectEvent(dismiss)
  const closeEvent = useEffectEvent(onClose)

  useEffect(() => {
    if (!open) return

    const onKey = (event: KeyboardEvent) => {
      if (overlayKeyAction(event) !== 'close') return
      event.preventDefault()
      dismissEvent()
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as globalThis.Node | null
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return

      const wasInside = panelRef.current?.contains(document.activeElement) ?? false
      closeEvent()

      // Where the focus ends up is the browser's answer rather than this handler's, so the rule is
      // read once the press has finished being one: `mousedown` focuses the pressed control after
      // this listener has run, and the panel unmounts in between. The wait is owned by the settler
      // rather than by this effect, whose whole lifetime is `open === true` — the close above ends
      // it, and a wait cancelled by the transition that scheduled it never reads anything.
      settling.after(() => {
        const landed = document.activeElement !== null && document.activeElement !== document.body
        if (restoresTriggerAfterOutsidePress(wasInside, landed)) triggerRef.current?.focus()
      })
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, settling])

  // The one cancellation. A picker that has gone has no trigger to give the focus back to.
  useEffect(() => () => settling.cancel(), [settling])

  return { triggerRef, panelRef, dismiss }
}

export function ExternalConfirm({ pending, onClose }: { pending: PendingLink; onClose: () => void }) {
  const { dialogRef, initialRef } = useModalDialog<HTMLButtonElement>(onClose)

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-title"
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="dialog__title" id="external-title">
          Open this on GitHub?
        </p>
        <p className="dialog__body">{pending.label}</p>
        <p className="dialog__url">
          <code>{pending.url}</code>
        </p>
        <div className="dialog__actions">
          <button
            className="button"
            type="button"
            onClick={onClose}
          >
            Stay here
          </button>
          <button
            className="button button--primary"
            type="button"
            ref={initialRef}
            onClick={() => {
              window.open(pending.url, '_blank', 'noopener,noreferrer')
              onClose()
            }}
          >
            <Icon name="external" /> Open in a new tab
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Where a viewer supplies their own GitHub token.
 *
 * Closed by default: the page works without one, so this is an answer to a limit somebody has hit
 * rather than a step on the way in. The value is theirs — it stays in their browser, goes only to
 * api.github.com, and is never shown in plain text.
 */
function TokenField() {
  const { token, setToken } = useTokenState()
  const [draft, setDraft] = useState(token)
  const [said, setSaid] = useState<string | null>(null)
  const fieldId = useId()

  return (
    <details className="token">
      <summary className="token__summary">
        GitHub token · {token ? 'set' : `raises the limit from ${UNAUTHENTICATED_HOURLY_LIMIT} to ${AUTHENTICATED_HOURLY_LIMIT} an hour`}
      </summary>
      <div className="token__body">
        <p className="token__note">
          A fine-grained token with read access to public repositories is enough. It is kept in this
          browser only, sent only to api.github.com, and never leaves with anything else.
        </p>
        <div className="token__row">
          <label className="token__label" htmlFor={fieldId}>
            Token
          </label>
          <input
            className="token__input"
            id={fieldId}
            type="password"
            value={draft}
            placeholder={token ? '••••••••' : 'github_pat_…'}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value)
              setSaid(null)
            }}
          />
        </div>
        <div className="stage__actions">
          <button
            className="button button--primary"
            type="button"
            disabled={draft.trim() === token}
            onClick={() => {
              const stored = draft.trim()
              setToken(stored)
              // The field shows what was actually stored, which is the trimmed value.
              setDraft(stored)
              setSaid(stored ? 'Token saved. Requests from now on use it.' : 'Token removed.')
            }}
          >
            Save
          </button>
          {token && (
            <button
              className="button"
              type="button"
              onClick={() => {
                setToken('')
                setDraft('')
                setSaid('Token removed. Requests are unauthenticated again.')
              }}
            >
              Remove
            </button>
          )}
        </div>
        {said && (
          <p className="token__said" role="status">
            {said}
          </p>
        )}
      </div>
    </details>
  )
}

/* Shared shell -------------------------------------------------------------
   One page for choosing a repository and for everything that has to be said
   before its graph can be drawn. The heading and the input never move; only the
   section underneath them changes, so opening a repository reads as the same
   page continuing rather than as a jump to another screen. */

export function Start({
  initial,
  onOpen,
  message,
  children,
}: {
  initial?: string
  onOpen: (target: RepoTarget) => void
  message?: string
  children?: React.ReactNode
}) {
  const { token } = useTokenState()

  return (
    <div className="centre">
      <div className="start">
        <h1 className="start__title">
          <Icon name="graph" size={20} /> Issue dependencies
        </h1>
        <p className="start__lead">
          Any public repository, from native GitHub issue relationships. Nothing is installed.
        </p>

        {message && <p className="notice notice--error">{message}</p>}

        <RepoInput initial={initial} onOpen={onOpen} token={token} />

        <TokenField />

        {children ? (
          <section className="stage">
            {/* Every fact below is about the repository the page is on, which is not necessarily
                the one being typed into the field above it. */}
            <p className="stage__for">
              <code>{initial}</code>
            </p>
            {children}
          </section>
        ) : (
          <p className="start__url">
            <code>{BASE}dependencies/owner/repo</code>
          </p>
        )}
      </div>
    </div>
  )
}
