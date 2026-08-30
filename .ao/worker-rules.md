# Worker rules

Attached to every orchestrated worker prompt through
`ao project set-config issues-graph --agent-rules-file .ao/worker-rules.md`. This file governs
local orchestrated workers; the `Agent execution` section of `AGENTS.md` governs every executor
that works from a bare clone.

## Execution mode

This is an unattended run: `AO_SESSION_ID` is set and nobody is available to answer questions.
The issue skills' unattended contract applies in full.

- Invoke skills by their exact names: `/issue-implement <n>`, `/issue-plan <n>`. Generic
  continuation language authorizes nothing.
- Proceed from delegated planning into implementation for any effort size, and record the
  skipped readback in the pull request body with the exact sentence the unattended contract
  defines.

## Parking instead of asking

When the run reaches something it cannot settle, park the issue: record the blocker on the issue,
then **put the question to the owner and wait**. A parked session stays open on purpose, because
that is what puts it in the board's *needs you* column. Ending cleanly hides it behind an idle
worker nobody looks at.

- **Blocked on a human choice** — apply `status: needs-decision`, post one comment stating exactly
  which choice is open and what is already established, then ask the owner and wait.
- **Blocked on a missing phase** — post one comment naming the missing phase, no label change,
  then name it to the owner and wait.
- **Disproven** — the run holds reproducible evidence that the issue's premise is false. Post that
  evidence and close the issue as not planned. This is the one disposition that ends clean, and
  the gate is a command a human can rerun with its output, never an assertion. Anything short of
  proof is parked. A disproven run also terminates its own session, so the card lands in the
  board's archive instead of sitting idle among live work.

Never invent a product decision, a provenance label, or a new `status:` value.

## Automatic merge

enabled

Arm `gh pr merge --auto --merge` only when **all** predicates hold: CI is green on the exact
current head; an approved review exists from a different model family than the implementer;
branch protection satisfied. Effort size is not a predicate; every approved change is eligible.
Record the basis in the PR body. Outside the predicates, leave the pull request open for the
owner.

## Effort and depth

| effort | reasoning depth | turn budget |
| --- | --- | --- |
| XS | low | 12 |
| S | medium | 20 |
| M | high | 30 |
| L | very high | 45 |
| XL | evaluate splitting before tasks are written |

## Roles and who fills them

Three roles, each selectable per issue by a label, each falling back to a repository default
when the issue does not say. The names match Agent Orchestrator's own roles.

| Role | Label | This repository's default |
| --- | --- | --- |
| Implementer | `implementer: claude\|codex\|antigravity` | **claude** |
| Reviewer | `reviewer: claude\|codex\|antigravity` | **codex** |
| Orchestrator | `orchestrator: claude\|codex\|antigravity` | **codex** |

**The issue outranks the default.** Honour an explicit label even when another pool has more
headroom; the label is the owner's decision, and quota is a reason to relabel rather than to
substitute silently.

Keep the implementer and the reviewer in different model families where you can. That is what
makes the automatic-merge different-family predicate reachable; a same-family pair is allowed
and simply leaves automatic merge unavailable.

### When the issue does not choose

Claude, Codex, and Antigravity are each eligible for **any local role at any effort level**, and
the owner selects freely between them. No measured quality difference between them is recorded,
so nothing here suggests one is better suited to a size or a kind of task.

What does differ is where the work is billed:

| Executor | Quota pool | Per-call cost |
| --- | --- | --- |
| Claude | Claude subscription | normal |
| Codex | ChatGPT subscription, separate pool | normal |
| Antigravity | Google AI subscription, separate pool | reported high fixed system-prompt overhead, unverified on the current release |

Two rules follow, and both are about economics rather than capability:

- **Pick the pool with headroom.** Three separate subscriptions let work run in parallel without
  exhausting any single pool. Read the quota before dispatching a batch.
- **Vary the family between implementing and reviewing.** A reviewer from a different vendor
  than the implementer disagrees more usefully than one sharing the same training and the same
  instructions.

The comparative evaluation may replace this guidance with measurement; it may never narrow the
selectable set.

## Phase provenance

Every pull request carries one line naming the phases that produced it, so which skills ran is
auditable from GitHub alone:

```text
Phases: issue-plan (delegated), issue-implement
```

Name only phases that ran, in order, marking a delegated one as `(delegated)`. A completed review
appends `issue-review (<harness>)`.

A second line names every other skill the run invoked, so specialized routing is visible too:

```text
Skills: skd-test-design, skd-github-publishing-conventions
```

Write `Skills: none` when the run reached no other skill; an omitted line is not the same claim as
an empty one. A run that cannot state what it invoked leaves the pull request for the owner.

## Review routing

A `reviewer:` label pins the lane. Without the label, the repository default applies. A provider
outage, a malformed result, an exhausted quota, or an unknown error leaves the review pending or
blocked; never substitute the reviewer silently.
Name the lane that produced the review in the pull request body, because the automatic-merge
different-family predicate reads that provenance.

## Boundaries

- Never push to `main`; the repository's pre-push guard enforces this for worker
  sessions.
- Discovered out-of-scope work may become one agent-proposed issue per finding, per the
  publishing conventions' agent-proposed section: capture-format body, provenance in body and
  signature, `type:` and `priority:` labels only — no assignee, no routing label, no `effort:`.
  Owner triage is the only path from proposal to execution.
