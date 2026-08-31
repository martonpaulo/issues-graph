# What an ELK layout costs the main thread

Measured 2026-08-31 for issue #16, whose worker question was deliberately left gated on a browser
measurement rather than on the local test timings.

## Why the local numbers were not enough

`npm test` lays the captured fixtures out in Node in 4–122 ms, which says how long the algorithm
takes but nothing about what the *page* is doing meanwhile. The question the issue asks is whether
layout blocks the browser's main thread long enough to matter, and only a browser can answer that.

## How it was measured

A temporary harness page imported `buildGraph` from the dev server, laid out each graph, and
recorded `PerformanceObserver` `longtask` entries — the platform's own definition of a main-thread
task long enough to be a problem, which is any task over 50 ms
([`PerformanceLongTaskTiming`](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming)).

Long-task durations rather than elapsed wall-clock, deliberately. ELK's bundled build schedules its
work through timers, and a browser throttles timers to roughly one per second while its window is
hidden: elapsed time then reports the throttling, while each task's own duration stays honest.

Chrome 130 (Electron 33), Apple Silicon. `arbaro` and `tabelo` are this repository's captured
fixtures; the synthesized graphs chain every node to the two before it, so ELK has to lay all of
them out rather than pack them loose.

`arbaro` was measured before that repository was renamed, and its fixture has since been re-captured
at 48 nodes and 58 edges (#108). The sizes in the tables below are the ones actually measured, so
they are left as they were read rather than restated against the larger fixture.

## Result: on the main thread, every real layout is a long task

| Graph | Nodes / edges | Main-thread long tasks |
| --- | --- | --- |
| `arbaro` | 25 / 40 | one task, 66–88 ms |
| `tabelo` | 46 / 5 | none |
| synthesized | 100 / 196 | one task, 222 ms |
| synthesized | 250 / 496 | one task, 672 ms |

`tabelo` is the shape that costs nothing: 46 issues with only 5 dependencies between them are packed
as a loose block, and ELK is barely asked to do anything. The cost tracks edges, not issues.

Everything else is a single uninterruptible task past the 50 ms threshold, growing faster than the
graph does — 672 ms at 250 nodes, during which the page cannot paint or answer a click.

### The budget these were read against

#16 made worker adoption conditional on an agreed long-task budget, and none was recorded. Presented
with the figures above, the owner delegated the choice
([#16 comment](https://github.com/martonpaulo/issues-graph/issues/16#issuecomment-5480157211)), and
the budget set is **the platform's own 50 ms**: the threshold at which a browser itself starts
calling a task long. Adopting somebody else's definition rather than inventing a number is what
keeps the gate checkable by anyone later, with `PerformanceObserver` and no argument about where the
line is.

Read against it, three of the four graphs exceed the budget and the worker was adopted. `tabelo` is
the one that passes, and it is worth saying why it does not weaken the case: it passes because it is
barely a graph, not because 46 issues are cheap.

## After: the same measurement with ELK in a worker

| Graph | Main-thread long tasks | Layout wall-clock |
| --- | --- | --- |
| `arbaro` | none | 89–109 ms |
| `tabelo` | none | 27 ms |
| synthesized 100 | none | 256 ms |
| synthesized 250 | none | 674 ms |

The work costs the same; it simply no longer happens where the page is. Wall-clock now matches the
CPU time measured before, which is the second confirmation that the layout really moved: the
bundled engine's throttled timers are gone with it.

## What the worker path costs to keep

`src/layoutWorker.ts` is the only file that knows about the worker. `src/graph.ts` imports it lazily
and falls back to `elk.bundled.js` where `Worker` does not exist, which is how the tests run the same
algorithm under Node. The build therefore emits both engines; the bundled one is a lazy chunk that no
browser ever fetches.

The containment is deliberate: the worker is one file plus one branch in `createEngine`, and it is
independent of the retry, failure-typing and stale-result work in the same change. Reversing this
decision later means deleting that file and that branch, and nothing else.
