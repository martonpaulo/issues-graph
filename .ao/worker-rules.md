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

When a needed choice is not settled by the issue: apply `status: needs-decision`, post one
comment naming the open choice and what is already established, and end the run cleanly. A
missing phase gets the comment without the label. Never invent a decision and never wait for an
answer.

## Automatic merge

Auto-merge: DISARMED — no required status checks on main; arming is forbidden until they exist.

Arm `gh pr merge --auto --merge` only when **all** predicates hold: the closing issue carries
`effort: XS`, `S`, or `M`; CI is green on the exact current head; an approved review exists from
a different model family than the implementer; no public interface change; no persisted
data-format change; no migration; branch protection satisfied. Record the basis in the PR body.
Outside the predicates, leave the pull request open for the owner.

## Effort and depth

| effort | reasoning depth | turn budget |
| --- | --- | --- |
| XS | low | 12 |
| S | medium | 20 |
| M | high | 30 |
| L | very high | 45 |
| XL | evaluate splitting before tasks are written |

## Default routing

Claude implements `M` and above; Codex implements `XS`/`S` volume; Antigravity reviews. This
table is the working assumption until the comparative evaluation replaces it with measurement.

## Boundaries

- Never push to `main`; the repository's pre-push guard enforces this for worker sessions.
- Discovered out-of-scope work may become one agent-proposed issue per finding, per the
  publishing conventions' agent-proposed section: capture-format body, provenance in body and
  signature, `type:` and `priority:` labels only — no assignee, no `jules` label, no `effort:`.
  Owner triage is the only path from proposal to execution.
