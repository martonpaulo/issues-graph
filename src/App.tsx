/**
 * The router, and nothing else.
 *
 * A reader who has not named a repository yet needs the shell and the repository field; the graph
 * runtime — React Flow, the canvas, its node and edge components — is worth hundreds of kilobytes
 * they have no use for, so it is reached through a lazy import and arrives only once a repository
 * route is entered. Keep every graph-side import inside `GraphView.tsx`: one eager import of it
 * from here or from `Shell.tsx` folds it back into the landing chunk.
 */
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

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

interface RouteProps {
  target: RepoTarget
  onOpen: (target: RepoTarget) => void
}

const GraphView = lazy(() => import('./GraphView'))

/**
 * Keeps a failed graph chunk from taking the page down with it.
 *
 * The import happens after the document is already open, so it can fail long after a successful
 * load: a deployment replaces the hashed assets this document names, or the request simply drops.
 * React unmounts the whole tree at an uncaught render error, and the reader is left with a blank
 * page and nothing to act on, which is worse than the failure itself.
 * https://react.dev/reference/react/Component#static-getderivedstatefromerror
 */
export class GraphBoundary extends Component<
  { fallback: ReactNode; children?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * What stands in while the graph chunk is fetched. It is the same shell the repository route
 * settles into, so entering a repository never blanks the page: the heading and the field stay
 * put, and only the section underneath them changes. On a fast connection the chunk is usually
 * already there and this is never painted.
 */
function GraphPending({ target, onOpen }: RouteProps) {
  return (
    <Start initial={slugOf(target)} onOpen={onOpen}>
      <p className="notice" role="status">
        Loading the graph…
      </p>
    </Start>
  )
}

/**
 * What the reader gets when it never arrives: the same shell again, what went wrong, and the one
 * action that fixes it.
 *
 * Reloading, and not an in-place retry. A failed module fetch is recorded in the document's module
 * map, so importing the same URL again resolves to that recorded failure rather than a new
 * request; a fresh `React.lazy` does not change the URL and so does not change the answer. Only a
 * new document clears the map — and it is also what picks up the current asset names after a
 * deployment replaced them, which is the likeliest reason the chunk was missing.
 * https://html.spec.whatwg.org/multipage/webappapis.html#module-map
 */
export function GraphUnavailable({ target, onOpen }: RouteProps) {
  return (
    <Start initial={slugOf(target)} onOpen={onOpen}>
      <p className="notice notice--error" role="alert">
        The graph could not be loaded. The page may have been open while a new version was
        deployed, or the request failed on the way. Nothing was read from GitHub, so no budget was
        spent.
      </p>
      <div className="stage__actions">
        <button
          className="button button--primary"
          type="button"
          onClick={() => window.location.reload()}
        >
          Reload the page
        </button>
      </div>
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
          <GraphBoundary fallback={<GraphUnavailable target={route.target} onOpen={openTarget} />}>
            <Suspense fallback={<GraphPending target={route.target} onOpen={openTarget} />}>
              <GraphView
                key={`${slugOf(route.target)}:${hashNav}`}
                target={route.target}
                onOpen={openTarget}
              />
            </Suspense>
          </GraphBoundary>
        ) : (
          <Start onOpen={openTarget} message={route.kind === 'invalid' ? route.reason : undefined} />
        )}
        {pending && <ExternalConfirm pending={pending} onClose={() => setPending(null)} />}
      </OpenExternalContext.Provider>
    </TokenContext.Provider>
  )
}
