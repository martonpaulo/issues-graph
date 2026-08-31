/**
 * The router, and nothing else.
 *
 * A reader who has not named a repository yet needs the shell and the repository field; the graph
 * runtime — React Flow, the canvas, its node and edge components — is worth hundreds of kilobytes
 * they have no use for, so it is reached through a lazy import and arrives only once a repository
 * route is entered. Keep every graph-side import inside `GraphView.tsx`: one eager import of it
 * from here or from `Shell.tsx` folds it back into the landing chunk.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'

import {
  BASE,
  ExternalConfirm,
  OpenExternalContext,
  Start,
  TokenContext,
  type PendingLink,
} from './Shell'
import {
  parseRoute,
  pathForTarget,
  slugOf,
  titleForRoute,
  type RepoTarget,
} from './route'
import { readToken, writeToken } from './token'

const GraphView = lazy(() => import('./GraphView'))

/**
 * What stands in while the graph chunk is fetched. It is the same shell the repository route
 * settles into, so entering a repository never blanks the page: the heading and the field stay
 * put, and only the section underneath them changes. On a fast connection the chunk is usually
 * already there and this is never painted.
 */
function GraphPending({ target, onOpen }: { target: RepoTarget; onOpen: (target: RepoTarget) => void }) {
  return (
    <Start initial={slugOf(target)} onOpen={onOpen}>
      <p className="notice" role="status">
        Loading the graph…
      </p>
    </Start>
  )
}


export function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const [pending, setPending] = useState<PendingLink | null>(null)
  const [token, setStoredToken] = useState(() => readToken())

  // writeToken returns what was actually stored, so the state and the store cannot disagree about
  // a trimmed or blanked value.
  const setToken = useCallback((value: string) => setStoredToken(writeToken(value)), [])
  const tokenState = useMemo(() => ({ token, setToken }), [token, setToken])

  /**
   * Arriving at a shared link for the repository already on screen changes only the fragment, and
   * the browser treats that as staying on the same document: nothing reloads, and the link would
   * appear to do nothing. Counting the navigations rather than storing the fragment keeps this
   * honest — `replaceState`, which is how the page clears a fragment it has finished with, fires
   * no event, so only a real navigation remounts.
   */
  const [hashNav, setHashNav] = useState(0)

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname)
    const onHashChange = () => setHashNav((count) => count + 1)
    window.addEventListener('popstate', onPopState)
    window.addEventListener('hashchange', onHashChange)
    return () => {
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [])

  const navigate = useCallback((next: string) => {
    window.history.pushState(null, '', next)
    setPathname(next)
  }, [])

  const route = useMemo(() => parseRoute(pathname, BASE), [pathname])

  // `pathname` is updated by both `navigate` and the `popstate` listener above, so this one effect
  // covers in-app navigation, Back and Forward without a second subscription.
  useEffect(() => {
    document.title = titleForRoute(route)
  }, [route])

  const openTarget = useCallback(
    (target: RepoTarget) => navigate(pathForTarget(target, BASE)),
    [navigate],
  )
  const openExternal = useCallback((url: string, label: string) => setPending({ url, label }), [])

  return (
    <TokenContext.Provider value={tokenState}>
      <OpenExternalContext.Provider value={openExternal}>
        {route.kind === 'graph' ? (
          <Suspense fallback={<GraphPending target={route.target} onOpen={openTarget} />}>
            <GraphView
              key={`${slugOf(route.target)}:${hashNav}`}
              target={route.target}
              onOpen={openTarget}
            />
          </Suspense>
        ) : (
          <Start onOpen={openTarget} message={route.kind === 'invalid' ? route.reason : undefined} />
        )}
        {pending && <ExternalConfirm pending={pending} onClose={() => setPending(null)} />}
      </OpenExternalContext.Provider>
    </TokenContext.Provider>
  )
}
