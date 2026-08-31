# Project Working Agreements

## Project identity and policy

- Project name: `issues-graph`
- Public name: `issues-graph`
- Benefit-first description: See the blocking order of a GitHub backlog as a graph, in a browser, with nothing installed in the repository being read.
- Repository: `martonpaulo/issues-graph` (public)
- Public identifiers: none published. The hosted page is the only public surface; there is no package, module, or executable identifier, and nothing consumes this repository as a dependency.
- Landing page: `https://martonpaulo.github.io/issues-graph/`, a GitHub Pages site built from this repository by `.github/workflows/pages.yml`. The page **is** the product, not a description of it; there is no separate marketing site.
- License: `MIT`
- Copyright: 2026 Marton Paulo
- Development language: English.
- Product copy: the interface text, in English, with no localization strategy. The audience is maintainers reading their own GitHub backlog, and every proper noun on screen — issue numbers, labels, repository names — comes from GitHub already.
- Branch policy: Branch-based. Work happens on a branch and merges into `main`; `main` is what is deployed, so it stays working.
- Commit policy: Automatic. Commit each completed concern without waiting to be asked.
- Push policy: Automatic. Push the working branch after committing.
- Product versioning: None. This is a continuously deployed page: `main` is what is live, and no consumer pins anything, so there is no compatibility contract for a version number to describe. Git history is the record. Do not add tags, a `CHANGELOG.md`, or release ceremony without an explicit decision to start versioning.
- Agent automation: `enabled`
- Implementation agent: `claude`
- Review agent: `codex`
- Orchestration agent: `codex`
- Merge policy: merge commits only, every commit of the branch preserved. Never squash.
- Commit subject: a commit made for an issue ends with `(#<issue number>)`.
- Delete branches after merge: Enabled.
- Review policy: `main` requires one approving review (ruleset `21918709`). The reviewing harness posts a `COMMENT` review because GitHub refuses an approving review from the account that opened the pull request; the approving identity is the operator's GitHub App `marton-agent-approver`, which `skd merge` uses once the orchestrator has recorded an approved verdict.
- Release and signing policy: Not applicable. Nothing is packaged or signed; deployment is a GitHub Pages build from `main`.
- Secret-storage policy: the product has no credential and every product read is unauthenticated. Agent-automation credentials, when provisioned, live only as GitHub Actions repository secrets and never in the repository or agent transcripts.
- Client guidance: Gemini CLI (`unavailable`) uses `GEMINI.md -> AGENTS.md`; Antigravity CLI (`unavailable`) uses root `AGENTS.md`. Functional verification is pending for both clients.
- Agent orchestration: Enabled for Agent Orchestrator local workers. `main` now carries required status checks (`validate`, `pr-conventions`), so auto-merge is armable under the predicates recorded in `.ao/worker-rules.md`; `skd merge` remains the path for a verdict the orchestrator recorded.
- Skills baseline revision: `10d02773253766a032f490f1a5ec27d2157f3281`
- Skills baseline applied: `2026-08-31`

Treat these values as stable project decisions. Change an established identifier, license, visibility, branch policy, versioning model, localization strategy, landing-page contract, agent-automation decision, or release policy only through an explicit task that describes the migration and downstream effects.

## Where this sits

Three repositories divide this work, and the boundary is the point:

| Repository | Owns |
| --- | --- |
| [`martonpaulo/skills`](https://github.com/martonpaulo/skills) | The agent skills that capture, plan and groom issues, and that **create and verify** the GitHub dependencies rendered here |
| [`martonpaulo/arbaro`](https://github.com/martonpaulo/arbaro) | The reusable GitHub Actions engine that implements issues and reviews pull requests |
| **`martonpaulo/issues-graph`** | This repository. It reads and draws; it never writes |

Data flows one way — skills create the dependencies, GitHub holds them, this renders them — and this
repository is the end of it. It has no authority over anything it displays. A change here can make a
graph wrong on screen; it can never make a backlog wrong.

## Agent skill paths

Where project skills write their artifacts. Paths are recorded; nothing is created until it has real
content — no empty files or directories.

- Product definition: `docs/product.md`
- Architecture decisions (ADRs): `docs/adr/` (create when the first decision is recorded — the
  layout engine, the unauthenticated-only boundary and the Pages SPA fallback are the candidates)
- Research notes: `docs/research/` (create when persisting research, e.g. observed GitHub REST
  rate-limit behavior)
- Handoffs: `.scratch/handoffs/`
- Prototypes: `.scratch/prototypes/`

No domain glossary. The vocabulary on screen is GitHub's own — issue, `blocked by`, `blocking`,
label — and inventing a second name for any of it would be the drift a glossary exists to prevent.

## Agent execution

Rules for any executor working from a clone of this repository, including cloud executors that
read only committed files.

- Run tests with `npm test`; run lint with `npm run lint`. A change is not done while either fails
  on the exact current head.
- Branch as `<type>/<agent>/issue-<n>/<short-slug>`; commit with Conventional Commits, subject
  ending in `(#<n>)`.
- Never push to `main` and never merge: open a pull request and stop. Merge belongs to the owner,
  or to GitHub auto-merge under the predicates recorded in `.ao/worker-rules.md`.
- Start the PR body with one `Closes #<n>` line per resolved issue, then the problem, the
  implementation, the tests run with results, and the residual risk.
- Do not touch: `AGENTS.md`, `.ao/`, or `.github/workflows/`.
- When a needed decision is not written in the issue: comment exactly what is missing, apply
  `status: needs-decision`, and stop cleanly instead of guessing.

## Patterns

These are the conventions the code already repeats, discovered from it rather than imposed.

**One module owns every GitHub request; one pure module owns the graph transform and layout.**
Neither imports the other's concern. That separation is what lets the layout be tested against
captured payloads with no network, and what keeps request policy — budget quoting, caching,
pagination — in one place instead of spread through the rendering code.

**Fixtures are captured, never hand-written.** `scripts/capture-fixtures.mjs` records real API
payloads into `src/__fixtures__/`. A hand-written payload asserts what somebody assumed the API
returns, which is exactly the assumption a test should be catching. Capture a new one rather than
editing an existing one to fit.

**The stack is React with Vite, `@xyflow/react` for the canvas and `elkjs` for layout and edge
routing, TypeScript, and Vitest.** It is a static page that reads the public GitHub REST API
unauthenticated from the browser: no backend, no token, no build-time data.

**The GitHub Pages SPA fallback is load-bearing.** `vite.config.ts` copies `index.html` to
`404.html` at build time so a real route such as `/dependencies/owner/repo` is served by the same
document. Pages returns HTTP 404 for that path by design and the client router then renders it; the
status code is expected and is not a bug to fix. Removing the copy breaks every deep link.

When a change would break a recorded pattern or establish a new one, stop and ask first, naming the
existing pattern, the proposed one, and why the existing one does not fit. Deviating is allowed;
deviating silently is what produces two ways of doing the same thing.

## Instruction hierarchy and sources of truth

- Follow the direct task, the most specific applicable scoped instructions, this root file, and then general working agreements, in that order.
- Read applicable instructions before changing files.
- Code is evidence of current behavior. `AGENTS.md` is normative for process. An approved specification is normative for desired behavior. Expose divergence among them; do not silently resolve every conflict in favor of one source.
- Keep one canonical source for each rule. Secondary documents should summarize or link to it instead of restating it.
- Do not turn analysis, research, or a read-only audit into implementation without authorization.
- Be direct and evidence-based. State assumptions, uncertainty, risks, tradeoffs, and blockers.
- Ask only when a material decision cannot be discovered safely. Prefer explicit, reversible assumptions when enough context exists.
- Give concise progress updates during long-running work.

## Long-running operations

For any command, process, browser action, integration, or delegated task likely to run long:

- Use the client's bounded yield, timeout, or status mechanism and wait for an observable
  condition instead of an arbitrary sleep.
- Keep the user informed at least once per minute when the client supports progress commentary.
- Distinguish slow but progressing work from a stall using new output, state changes, resource
  activity, the known duration of the current phase, or a tool-reported deadline. Elapsed time
  alone is not evidence of a stall.
- Inspect the current output and state before interrupting, retrying, or changing approach.
- Interrupt only when there is evidence of no useful progress, a deadline has expired, or the
  continued cost or risk is no longer justified.
- After an interruption, explain what state or output was preserved, diagnose the likely cause,
  and choose a narrower retry, a different tool, a smaller unit of work, or an explicit blocker.
- Never rerun the same unchanged failure, and do not add a polling service, background job, timer,
  or other infrastructure merely to satisfy this rule.
- Keep termination thresholds task-specific. Workflow-specific wait tools and user-input
  boundaries remain authoritative.

## Before editing

1. Check applicable instructions, Git status, and the current branch.
2. Search for the behavior, callers, tests, contracts, and nearby patterns before adding anything.
3. Read only the files and chunks required to understand the affected behavior.
4. Distinguish verified facts, reasonable inferences, and unknowns.
5. Define the source of truth and ownership before changing data or state.
6. Make a short plan only for complex, risky, ambiguous, or multi-file work.

## Scope, reuse, and implementation

- Keep changes scoped to the requested result. Do not mix unrelated cleanup, redesign, dependency updates, broad refactors, or future work.
- Preserve behavior outside the task and preserve unrelated or uncommitted user changes.
- Search for existing components, services, types, helpers, tokens, configuration, tests, and platform capabilities before creating new ones.
- Follow the patterns this project already repeats. When a change would break a recorded pattern or establish a new one, stop and ask first, naming the existing pattern, the proposed one, and why the existing one does not fit. Deviating is allowed; deviating silently is not.
- Prefer the smallest correct, readable, reversible, and low-operational-cost solution.
- Maintain one owner and one source of truth for each business rule, state, mapping, default, and copy value.
- Keep business rules out of presentation, transport, CLI, and external-adapter layers when a domain owner exists.
- Derive values instead of storing synchronized copies. Model invalid states explicitly.
- Do not add dependencies, services, layers, caches, observers, timers, polling, background jobs, or infrastructure without a current requirement and a clear owner.
- For large changes, use reviewable, executable increments and patches small enough to diagnose failures. Do not fragment one coherent concern mechanically.
- Implement relevant errors, states, accessibility, and tests with the behavior rather than as unrelated follow-up work.

## Data, security, and destructive operations

- Distinguish canonical data, reconstructible cache, transient state, local preferences, durable intent, and operating-system artifacts.
- Persist or synchronize only data that must survive or cross devices. Never turn a cache or mirror into an independent source of truth.
- Use stable application-owned identifiers. Validate data at input and persistence boundaries.
- Make every relational schema change through an explicit, deterministic, tested, versioned migration. Never edit a production schema manually.
- Use transactions or atomic writes when partial failure could leave inconsistent state. Preserve unrelated fields during external updates.
- Request only necessary permissions, fields, and scopes. Keep credentials, tokens, private keys, signing material, personal data, and sensitive payloads out of the repository and logs.
- Use structured subprocess arguments and validate destinations, redirects, and untrusted inputs.
- Resolve an exact target before deletion, overwrite, interruption, or another hard-to-recover action. A clear request authorizes its exact resolved operation; ask again when the target is ambiguous, loss is difficult to recover, or effects exceed the named scope.
- Prefer recoverable deletion where practical. Never force-push or perform broad cleanup without explicit authorization.

## Product interface and accessibility

- Prefer native platform components and established product patterns. Custom UI must provide clear product or domain value.
- Define layout, hierarchy, controls, loading, content, empty, error, retry, disabled, cancellation, and destructive states when applicable.
- Include keyboard navigation, focus, screen-reader labels, scalable text, contrast, safe areas, reduced motion, and non-color status cues in the same change.
- Keep visible copy centralized, localized, and consistent with the product language strategy.
- Keep expensive work out of render paths, hot loops, and latency-sensitive request paths. Prefer event-driven, on-demand, bounded, incremental, lazy, paginated, and cancelable work.
- Measure before claiming a performance problem and optimize measured user-visible bottlenecks.

## Code, comments, and documentation

- Write code, comments, commits, filenames, tests, configuration, and developer documentation in English. Product copy follows the recorded localization strategy.
- Follow the existing formatter, linter, naming, file layout, and architectural conventions.
- Prefer clear types, explicit ownership, and simple control flow over cleverness.
- Put comments next to non-obvious constraints. Explain intent, provenance, or a subtle external rule, not mechanics.
- Link official documentation in a code comment when an external rule or workaround must remain visible to prevent a future regression.
- Durable documentation describes responsibilities, contracts, invariants, commands, and decisions. Audits cite exact evidence. Manuals use exact filenames only when users must act on them and the names are stable contracts.
- Update the smallest canonical documentation section when a durable contract changes. Do not create empty documentation for possible future use.
- Keep the README easy to scan. Cover benefit, behavior, requirements, setup, usage, validation, security, privacy, limitations, landing page, and download where applicable.
- When creating a README or materially updating one, use the recorded `Public name` above as the H1
  and preserve an existing approved H1, including its branding and casing. Humanize the raw
  repository slug only when the public name is unresolved; never mechanically title-case an
  approved name or sweep unrelated README content.
- Every fenced code block you create or materially edit has an explicit language identifier. Use
  the real language for code or configuration and `text` for plain commands or output; leave
  untouched historical fences alone.
- Use badges, real screenshots, statistics, and emoji only when they improve comprehension and can remain current.
- Preserve third-party licenses, copyright, attribution, and notices. Maintain `NOTICE.md` or the established attribution file when required.

## Durable project learning

At workflow wrap-up, assess whether the work produced a learning that should outlive the current
session. A learning qualifies only when it is verified, specific to this project, likely to recur,
and belongs in a durable source.

Qualifying examples include:

- reproducible build, test, setup, or recovery commands that were actually run;
- an ownership boundary or invariant established by code and accepted guidance;
- a recurring failure shield with a verified cause; or
- a versioned external constraint whose source must remain visible.

Hypotheses, one-off debugging steps, raw logs, issue-specific implementation details, transient
environment state, machine-specific paths, credentials, personal data, and model conclusions
without evidence do not qualify.

Compare each qualifying learning with the existing canonical guidance, README, scripts, and
architecture records. If the learning is already recorded, do nothing. If it is absent or
contradictory, present one compact proposal that names the evidence, the canonical owner, the exact
section or script, and the smallest intended change. Use the shared proposal fields `Evidence`,
`Canonical owner`, `Smallest change`, `Draft`, and `Decision requested`. The draft is the exact
section or script change being proposed; end with `Decision requested: Approve, reject, or revise.`
Do not create a new file when an existing owner can hold the learning, and do not turn a convenience
into a mandatory convention.

Documentation required by the selected behavior remains part of the current task and needs no
additional approval. An adjacent learning outside the accepted scope is proposal-only and waits for
explicit owner approval before editing, staging, or committing. Behavior-changing configuration or
script work is a separate approved task and never enters through the documentation gate. Do not
delay the requested task result while waiting on an adjacent proposal, and do not publish the
proposal externally on your own.

## Skills

This repository owns no skills of its own. Every task follows normal skill triggering from the
personal collection.

The precedence rule still applies, so it does not have to be rediscovered when the first project
skill appears: when a project skill and a general skill both cover a task, the project skill owns
the project-specific procedure and the general skill keeps the process around it. A task no project
skill claims follows normal skill triggering.

## User attention cards

When the user must notice and respond to a proposed follow-up, a material choice, a permission
boundary, or a blocker, use exactly one of the four attention cards below. Never hide one inside a
general summary, ordinary bullet list, or vague "human review" note.

The English labels in the templates name the semantic fields; they are not fixed user-facing copy.
Render every visible heading, field label, explanation, option, recommendation, and reply token in
the language already used with the user. If the user changes language explicitly, follow the latest
choice. Keep code, commands, paths, identifiers, and quoted source text in their required form.

Surround every card with a Markdown horizontal rule: a standalone `---` before its heading and
another after its final response line. When cards are consecutive, one rule may separate them. The
emoji supplements the descriptive heading and never replaces it. Use one card per requested
decision, approval, action, or issue proposal, and end with an exact response format the user can
copy.

### Raise the card through the question tool

A card written only as Markdown is a message, and a message ends the turn. The agent stops, the
orchestrator marks the session idle, and a decision that was genuinely blocking looks answered.
The card is the record; it is not the asking.

So whenever the client offers a native structured-question facility — `AskUserQuestion` in Claude
Code, the equivalent elicitation or form input in other agents — put the question through it. The
tool call is what actually holds the turn open, and it is what makes an orchestrated session
report **Blocked** rather than looking finished. Map the card onto it directly: the card's heading becomes the question, each row of the
options table becomes one option with its tradeoffs as the description, and the recommended option
goes first, marked as recommended.

Write the card too, in the same turn. The tool renders a compact chooser, while the card carries
the evidence, the impact and the reasoning that the chooser has no room for. One without the other
loses something: the tool alone strips the argument, the card alone never asks.

Fall back to the card alone only when the client has no such facility. A run that wrote only the
card has not asked, however clearly it was worded.


### Proposed issue

Use this card when the work uncovers a distinct, evidence-backed, implementable improvement outside
the accepted scope that is valuable enough to preserve and is not already tracked. A durable
research note or other repository artifact does not replace this visible proposal. Do not propose
issues for incidental observations, speculative ideas without enough evidence, already tracked
work, or changes completed within the current task. The card proposes backlog capture; it never
authorizes creating or publishing the issue.

This card assumes a reader. An unattended run has none, so it does not write the card: it invokes
`issue-capture` and opens the issue directly, against the same bar. The unattended rules in
`.ao/worker-rules.md` are authoritative for that lane.

```markdown
---

## 🆕 Proposed issue: <short title>

**What I need from you:** Approve, reject, or revise this issue proposal.

### Why this matters

<Explain the user or project impact in plain language.>

### Current situation

<Explain what happens today and the evidence found.>

### Proposed outcome

<Explain what should become possible or improve after implementation.>

### Why this is a separate issue

<Explain why it is valuable but outside the current task.>

### My recommendation

<Explain briefly why opening the issue is worthwhile.>

**Reply with:** `Approve issue`, `Reject issue`, or `Revise: ...`

---
```

### Decision needed

Use this card when the user must choose among materially different outcomes. State why the choice
cannot be made safely from existing evidence, show the meaningful options and tradeoffs, and make a
clear recommendation. Do not stop at "human review needed."

```markdown
---

## 🧭 Decision needed: <question>

**What I need from you:** Choose one of the options below.

### Why this decision is needed

<Explain what cannot be decided safely without the user's preference.>

### Options

| Option | What it means | Advantages | Disadvantages |
| --- | --- | --- | --- |
| A — <name> | <plain explanation> | <benefits> | <tradeoffs> |
| B — <name> | <plain explanation> | <benefits> | <tradeoffs> |

### My recommendation

**Option <X>**, because <short evidence-based reason>.

**Reply with:** `Option A`, `Option B`, or `Revise: ...`

---
```

### Approval needed

Use this card when one exact action is already preferred but crossing a permission, publication,
destructive-operation, cost, privacy, or external-mutation boundary requires approval. Name the
exact target, expected change, risk, reversibility, and recovery path. Approval covers only the
stated action.

```markdown
---

## 🔐 Approval needed: <exact action>

**What I need from you:** Approve or decline this specific action.

### Proposed action

<Describe exactly what will be changed, published, deleted, or executed.>

### Why it is needed

<Explain the benefit and why the action cannot be avoided.>

### Impact and safety

- **Target:** <exact repository, file, branch, service, or data>
- **Expected change:** <what will be different>
- **Risk:** <what could go wrong>
- **Reversible:** <yes or no, and how>
- **Recovery:** <how the previous state can be restored>

### My recommendation

<Recommend approval or rejection, with a short reason.>

**Reply with:** `Approve`, `Decline`, or `Revise: ...`

---
```

### Action needed

Use this card when work is blocked by one specific external action from the user rather than by a
choice or permission decision. State what is blocked, why the agent cannot continue, the smallest
unblocking action, and the observable condition for resumption.

```markdown
---

## ⛔ Action needed: <blocking condition>

**What I need from you:** <one specific action>.

### What is blocked

<Explain which requested work cannot continue.>

### Why I cannot continue

<Explain the verified blocker in plain language.>

### How to unblock it

1. <First exact action>
2. <Second action, only when necessary>

### I can continue when

<Describe the observable condition that confirms the blocker is resolved.>

---
```

## Configuration and repository hygiene

- Ignore secrets, local environments, logs, caches, build output, and generated artifacts appropriate to the actual stack.
- Configure dependency updates, CI, release workflows, a release channel, signing, and secure secret storage when distribution or project risk requires them. Do not add placeholder automation.
- Change GitHub's repository `homepage` to the recorded canonical landing-page URL only when the
  Pages site exists, the latest `github-pages` deployment succeeded, and both GitHub URL surfaces
  agree with that recorded URL. When the value differs, preview and confirm the exact change, then
  read `homepage` back through the API. Otherwise leave it unchanged and report the evidence gap;
  do not enable or deploy Pages as setup work.
- Keep secrets in the platform or provider's secure store, never in versioned files.

## Tests and validation

- Add or update focused tests for changed behavior, regressions, validation, and critical accessibility, against captured fixtures rather than hand-written payloads.
- Test observable contracts at stable seams; avoid tests that only mirror implementation details or framework behavior.
- Run the smallest relevant check during iteration. Inspect the first useful failure and make a relevant change before rerunning it.
- Once stable, run one broader validation proportional to risk. Use a bounded real integration only when mocks and local tests cannot prove the relevant contract.
- Never claim a check passed unless it ran successfully. Report exact skips, blockers, residual risk, and manual gaps.

## Artifacts and processes

- Temporary is the default; retention is an explicit repository exception.
- Remove only temporary files created by the current task when they are no longer needed. Preserve deliverables, next-phase inputs, failure evidence, and anything protected by repository policy.
- Never delete pre-existing user artifacts, fixtures, baselines, or logs merely because they look temporary.
- Use the repository's established artifact location and never version secrets, caches, local logs, coverage, or build output without an explicit requirement.
- Stop servers, watchers, browsers, simulators, containers, workers, and other processes started by the task. Do not stop the user's pre-existing processes.

## Git and releases

- Follow the recorded branch, commit, push, and version policies.
- Check status and branch before editing and before the final report. Work only on task files and leave unrelated changes untouched.
- Use Conventional Commits in English. Make one commit per concern: a small task usually has one; a large task may have several independent concerns. Do not split mechanically or combine unrelated changes.
- End a commit subject with its issue number when the commit belongs to one: `feat: add the export button (#54)`. Use the issue number, never the pull request's, and leave the suffix off when there is no issue.
- Merge a branch with all of its commits: `gh pr merge <number> --merge --delete-branch`. Never squash. Squashing discards the one-commit-per-concern history and every issue reference but one.
- Inspect the exact payload before publishing it: the staged diff before a commit, the outgoing
  commit range before a push, the final text before an issue, pull request, comment, or review, and
  the artifact set before a release upload. Never commit secrets, caches, generated logs, temporary
  artifacts, or unrelated formatting churn.
- Stop before the mutation when the payload holds a credential, token, key, signing material, or
  sensitive personal value. Report the file, a masked location, and the category; never print the
  value. Offer a placeholder, a secret-store reference, or removal from scope. An explicit request
  to publish a plaintext secret is refused: authorization can permit a publication, it cannot make
  a secret safe.
- If a value may already be published, deleting it from the latest tree does not unpublish it. Stop
  further spread, state the reach without repeating the value, and revoke or rotate it before any
  decision about rewriting history.
- Never force-push. If commit or push fails, report the exact failure without claiming success.
- This project publishes no releases and carries no version. Do not create a tag, a `CHANGELOG.md`, or a release without an explicit decision to start versioning.

## Completion report

Lead with the outcome and include:

- what changed and why;
- files touched;
- validation commands and actual results;
- warnings, failures, skips, manual gaps, and remaining risks;
- temporary artifacts kept or removed;
- commit, branch, and push status when applicable;
- final worktree status and unrelated dirty files left untouched.
