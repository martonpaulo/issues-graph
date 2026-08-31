import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The worker adapter itself, which the rest of the suite cannot reach.
 *
 * `layoutWorker.ts` is browser-only: it constructs a `Worker` and imports the engine's script as a
 * URL, so `graph.ts` loads it lazily and falls back to the bundled engine under Node. That left its
 * error and termination handling — the two things that decide whether a draw can fail rather than
 * hang — resting on manual browser checks. Substituting `Worker` and the ELK API brings the adapter
 * under test without pretending the real worker runs here: what is asserted is this file's own
 * wiring, not ELK's behavior.
 */
const state = vi.hoisted(() => ({
  /** Listeners the adapter registered, so a worker's failure can be delivered as the page would. */
  listeners: new Map<string, (event: unknown) => void>(),
  terminations: 0,
  workers: 0,
}))

vi.mock('elkjs/lib/elk-worker.min.js?url', () => ({ default: 'blob:elk-worker' }))

vi.mock('elkjs/lib/elk-api.js', () => {
  class FakeELK {
    // A layout that never settles: exactly what a dead or terminated worker leaves behind, since
    // elk-api only ever resolves on a reply that is no longer coming.
    layout(): Promise<unknown> {
      return new Promise(() => {})
    }

    terminateWorker(): void {
      state.terminations += 1
    }
  }

  return { default: FakeELK }
})

class FakeWorker {
  constructor() {
    state.workers += 1
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    state.listeners.set(type, handler)
  }

  terminate(): void {}
}

beforeEach(() => {
  state.listeners.clear()
  state.terminations = 0
  state.workers = 0
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function engine() {
  const { workerEngine } = await import('./layoutWorker')
  return workerEngine()
}

describe('a worker that dies takes its layout down with it', () => {
  it('rejects the layout when the worker reports an error', async () => {
    const elk = await engine()
    const laying = elk.layout({ id: 'root' })

    state.listeners.get('error')?.({ message: 'Failed to load script' })

    await expect(laying).rejects.toThrow('Failed to load script')
  })

  it('names the failure when the error event carries no message', async () => {
    const elk = await engine()
    const laying = elk.layout({ id: 'root' })

    // A load failure and a cross-origin error both arrive without one.
    state.listeners.get('error')?.({ message: '' })

    await expect(laying).rejects.toThrow('The layout engine could not be loaded.')
  })

  it('rejects the layout when a reply cannot be read', async () => {
    const elk = await engine()
    const laying = elk.layout({ id: 'root' })

    state.listeners.get('messageerror')?.({})

    await expect(laying).rejects.toThrow('could not be read')
  })
})

describe('terminating settles the work it stops', () => {
  /**
   * The leak this covers: `terminate()` fires no `error` event and `elk-api` keeps the pending
   * layout's resolver, so a draw abandoned mid-layout used to leave a promise that could never
   * settle — holding the graph it was handed, once per abandoned draw.
   */
  it('rejects a layout that was still running', async () => {
    const elk = await engine()
    const laying = elk.layout({ id: 'root' })

    elk.terminate()

    await expect(laying).rejects.toThrow('The layout was stopped.')
    expect(state.terminations).toBe(1)
  })

  it('still stops the thread', async () => {
    const elk = await engine()

    elk.terminate()

    expect(state.terminations).toBe(1)
  })

  it('rejects a layout started after termination rather than leaving it pending', async () => {
    const elk = await engine()
    elk.terminate()

    await expect(elk.layout({ id: 'root' })).rejects.toThrow('The layout was stopped.')
  })
})
