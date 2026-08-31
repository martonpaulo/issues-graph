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
 * The budget agreed under #16 is the platform's own 50 ms, so those figures are what put this file
 * here. `docs/research/elk-layout-main-thread-cost.md` records the measurement and the decision.
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
  const worker = new Worker(elkWorkerUrl)

  // `new Worker(url)` succeeds whatever the URL says: the fetch happens afterwards, and a script
  // that 404s or throws while loading reports itself through an `error` event instead. `elk-api`
  // listens for `message` and nothing else — a layout's resolver is stored under its id and only
  // ever removed by a reply — so a worker that dies leaves that promise pending for the life of the
  // page. Every rejection handler in this codebase would then be waiting on a promise that cannot
  // settle, and the page would sit on "Laying out the graph…" exactly as it did before #16.
  //
  // So the worker's death is turned into a rejection of its own, and every layout races against it.
  let died: (error: Error) => void = () => {}
  const death = new Promise<never>((_, reject) => {
    died = reject
  })
  // A death nobody is waiting on is not an unhandled rejection; it is a worker that failed while
  // the page happened to be idle, and the next layout is what needs to hear about it.
  death.catch(() => {})

  const fail = (message: string) => {
    died(new Error(message))
  }
  worker.addEventListener('error', (event: ErrorEvent) => {
    // A cross-origin or load failure arrives with no message, so the fallback names what happened
    // rather than reporting an empty one.
    fail(event.message || 'The layout engine could not be loaded.')
  })
  worker.addEventListener('messageerror', () => {
    fail('The layout engine sent a reply that could not be read.')
  })

  const elk = new ELK({ workerFactory: () => worker })

  return {
    layout: (graph) => Promise.race([elk.layout(graph), death]),
    terminate: () => {
      // Terminating stops the thread and settles nothing. `elk-api` keeps the pending layout's
      // resolver, and the death above only rejects on an `error` event, which `terminate()` does
      // not fire — so without this the race stays pending for the life of the page, holding the
      // graph it was handed and whatever the caller captured around it. One per abandoned draw,
      // and a page that navigates repeatedly abandons one each time.
      //
      // Rejecting first means the race is already settled when the thread goes away, so a
      // terminated engine reports a stopped layout rather than a silent one.
      fail('The layout was stopped.')
      elk.terminateWorker()
    },
  }
}
