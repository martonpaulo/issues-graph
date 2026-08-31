import ELK from 'elkjs/lib/elk-api.js'
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url'

/**
 * ELK in a real Web Worker.
 *
 * `elk.bundled.js` runs the same algorithm on the page's own thread. Measured in Chrome against
 * this repository's captured fixtures, one layout is a single long task: 66–88 ms for the 25-node
 * `agent-workflows` graph, 222 ms at 100 nodes, 672 ms at 250 nodes — every one of them past the
 * platform's own 50 ms definition of a long task, and growing faster than the graph does. Nothing
 * on the page can paint or answer a click for that whole time.
 *
 * `elk-api` is the same engine with the worker left to the caller, so this is the only file that
 * differs, and it is the browser-only one: `graph.ts` imports it lazily and falls back to the
 * bundled engine where `Worker` does not exist, which is how the tests run ELK under Node.
 *
 * https://github.com/kieler/elkjs#web-worker
 * https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming
 */
export interface WorkerEngine {
  layout(graph: Parameters<InstanceType<typeof ELK>['layout']>[0]): Promise<unknown>
  /** Stops a layout the page has moved on from, which is the only way to stop one at all. */
  terminate(): void
}

export function workerEngine(): WorkerEngine {
  // Vite emits the worker script as its own asset and hands back its URL; the file is a classic
  // script, so the worker is constructed without `type: 'module'`.
  const elk = new ELK({ workerFactory: () => new Worker(elkWorkerUrl) })

  return {
    layout: (graph) => elk.layout(graph),
    terminate: () => elk.terminateWorker(),
  }
}
