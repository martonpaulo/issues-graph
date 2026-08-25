import {
  Background,
  BackgroundVariant,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { buildGraph, type IssueGraph } from './graph'
import { loadRepositoryGraph, UNAUTHENTICATED_HOURLY_LIMIT, type LoadFailure } from './github'
import { IssueCard, type IssueNode } from './IssueCard'
import { DEFAULT_OWNER, parseRoute, parseTargetInput, pathForTarget, type RepoTarget } from './route'

const BASE = import.meta.env.BASE_URL
const NODE_TYPES = { issue: IssueCard }

const LEGEND = [
  ['ready', 'ready'],
  ['blocked', 'blocked'],
  ['attention', 'needs attention'],
  ['completed', 'closed'],
] as const

type ViewState =
  | { kind: 'loading'; done: number; total: number }
  | { kind: 'failed'; failure: LoadFailure }
  | { kind: 'ready'; graph: IssueGraph }

function formatReset(reset: Date | null): string {
  if (!reset) return 'shortly'
  return reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function failureText(target: RepoTarget, failure: LoadFailure): { title: string; body: string } {
  const slug = `${target.owner}/${target.repo}`
  switch (failure.kind) {
    case 'not-found':
      return {
        title: 'Nothing to read',
        body: `No public repository at ${slug}, or its issues are not readable without signing in.`,
      }
    case 'rate-limited':
      return {
        title: 'GitHub rate limit reached',
        body: `Unauthenticated requests share ${UNAUTHENTICATED_HOURLY_LIMIT} per hour per IP address. It resets around ${formatReset(failure.reset)}. Showing nothing rather than a misleading part of the graph.`,
      }
    case 'network':
      return { title: 'GitHub could not be reached', body: failure.message }
    case 'unexpected':
      return { title: `GitHub answered ${failure.status}`, body: failure.message }
  }
}

function Centred({
  title,
  body,
  onRetry,
}: {
  title: string
  body: string
  onRetry?: () => void
}) {
  return (
    <div className="centre">
      <div className="centre__card" role="status">
        <p className="centre__title">{title}</p>
        <p className="centre__body">{body}</p>
        {onRetry && (
          <button className="centre__retry" type="button" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  )
}

function Canvas({
  graph,
  slug,
  onReload,
}: {
  graph: IssueGraph
  slug: string
  onReload: () => void
}) {
  const { fitView } = useReactFlow()

  const nodes = useMemo<IssueNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: 'issue' as const,
        position: node.position,
        data: { node },
        draggable: false,
      })),
    [graph],
  )

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'default',
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      })),
    [graph],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      fitView
      minZoom={0.05}
      maxZoom={2}
      // Layout is automatic and every card is a link; dragging would only fight the click target.
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      aria-label={`Issue dependency graph for ${slug}`}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} className="dots" />

      <Panel position="top-left" className="bar">
        <a className="bar__home" href={BASE} title="All repositories">
          ←
        </a>
        <a
          className="bar__slug"
          href={`https://github.com/${slug}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {slug}
        </a>
      </Panel>

      <Panel position="top-right" className="bar">
        <button className="bar__button" type="button" onClick={() => void fitView()}>
          Fit
        </button>
        <button className="bar__button" type="button" onClick={onReload}>
          Reload
        </button>
      </Panel>

      {!graph.complete && (
        <Panel position="bottom-center" className="bar bar--warn">
          <span role="status">
            Incomplete
            {graph.rateLimited ? `, rate limit resets ${formatReset(graph.rateLimitReset)}` : ''} —
            no dependencies for {graph.unresolved.map((u) => `#${u.number}`).join(', ')}
          </span>
        </Panel>
      )}

      <Panel position="bottom-left" className="bar bar--legend">
        {LEGEND.map(([state, text]) => (
          <span key={state} className="key">
            <i className={`key__dot key__dot--${state}`} />
            {text}
          </span>
        ))}
      </Panel>

      <Panel position="bottom-right" className="bar bar--counts">
        <span>
          {graph.nodes.length} issues · {graph.edges.length} dependencies
        </span>
        <span className="bar__note" title="Outbound cross-repository edges are not fetched.">
          native blocked-by only
        </span>
      </Panel>
    </ReactFlow>
  )
}

function GraphView({ target }: { target: RepoTarget }) {
  const [reloadToken, setReloadToken] = useState(0)
  const slug = `${target.owner}/${target.repo}`
  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  // Keying on the reload token remounts the body, which resets it to loading without a
  // synchronous setState inside the fetching effect.
  return <GraphBody key={reloadToken} target={target} slug={slug} onReload={reload} />
}

function GraphBody({
  target,
  slug,
  onReload,
}: {
  target: RepoTarget
  slug: string
  onReload: () => void
}) {
  const [state, setState] = useState<ViewState>({ kind: 'loading', done: 0, total: 0 })

  useEffect(() => {
    const controller = new AbortController()

    loadRepositoryGraph(target, {
      signal: controller.signal,
      onProgress: ({ done, total }) => {
        if (!controller.signal.aborted) setState({ kind: 'loading', done, total })
      },
    })
      .then((result) => {
        if (controller.signal.aborted) return
        setState(
          result.ok
            ? { kind: 'ready', graph: buildGraph(result.data, target) }
            : { kind: 'failed', failure: result.failure },
        )
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({
          kind: 'failed',
          failure: {
            kind: 'network',
            message: error instanceof Error ? error.message : 'The request failed.',
          },
        })
      })

    return () => controller.abort()
  }, [target])

  if (state.kind === 'loading') {
    return (
      <Centred
        title={slug}
        body={
          state.total > 0
            ? `Resolving dependencies, ${state.done} of ${state.total}.`
            : 'Listing open issues.'
        }
      />
    )
  }

  if (state.kind === 'failed') {
    const { title, body } = failureText(target, state.failure)
    return <Centred title={title} body={body} onRetry={onReload} />
  }

  if (state.graph.nodes.length === 0) {
    return (
      <Centred title={slug} body="This repository has no open issues to draw." onRetry={onReload} />
    )
  }

  return (
    <ReactFlowProvider>
      <Canvas graph={state.graph} slug={slug} onReload={onReload} />
    </ReactFlowProvider>
  )
}

function Index({ onOpen, message }: { onOpen: (target: RepoTarget) => void; message?: string }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="centre">
      <div className="index">
        <h1 className="index__title">Issue dependencies</h1>
        <p className="index__lead">
          A dependency graph for any public GitHub repository, from native issue relationships.
          Nothing is installed in the repository you point it at.
        </p>

        {message && <p className="index__error">{message}</p>}

        <form
          className="index__form"
          onSubmit={(event) => {
            event.preventDefault()
            const target = parseTargetInput(value)
            if (!target) {
              setError('Enter a repository as owner/name.')
              return
            }
            setError(null)
            onOpen(target)
          }}
        >
          <input
            className="index__input"
            value={value}
            placeholder={`${DEFAULT_OWNER}/tabelo`}
            aria-label="Repository"
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="index__go" type="submit">
            Open
          </button>
        </form>
        {error && <p className="index__error">{error}</p>}

        <p className="index__url">
          <code>{BASE}dependencies/owner/repo</code>
        </p>
      </div>
    </div>
  )
}

export function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname)

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback((next: string) => {
    window.history.pushState(null, '', next)
    setPathname(next)
  }, [])

  const route = useMemo(() => parseRoute(pathname, BASE), [pathname])
  const openTarget = useCallback(
    (target: RepoTarget) => navigate(pathForTarget(target, BASE)),
    [navigate],
  )

  if (route.kind === 'graph') {
    return <GraphView key={`${route.target.owner}/${route.target.repo}`} target={route.target} />
  }
  return <Index onOpen={openTarget} message={route.kind === 'invalid' ? route.reason : undefined} />
}
