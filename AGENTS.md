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
- Merge policy: merge commits only, every commit of the branch preserved. Never squash.
- Commit subject: a commit made for an issue ends with `(#<issue number>)`.
- Delete branches after merge: Enabled.
- Release, signing, and secret-storage policy: Not applicable. Nothing is published, packaged, or signed; deployment is a GitHub Pages build from `main`. This repository holds no secret and needs none — every read is unauthenticated.

Treat these values as stable project decisions. Change an established identifier, license, visibility, branch policy, versioning model, localization strategy, landing-page contract, or release policy only through an explicit task that describes the migration and downstream effects.

## Where this sits

Three repositories divide this work, and the boundary is the point:

| Repository | Owns |
| --- | --- |
| [`martonpaulo/skills`](https://github.com/martonpaulo/skills) | The agent skills that capture, plan and groom issues, and that **create and verify** the GitHub dependencies rendered here |
| [`martonpaulo/agent-workflows`](https://github.com/martonpaulo/agent-workflows) | The reusable GitHub Actions engine that implements issues and reviews pull requests |
| **`martonpaulo/issues-graph`** | This repository. It reads and draws; it never writes |

Data flows one way — skills create the dependencies, GitHub holds them, this renders them — and this
repository is the end of it. It has no authority over anything it displays. A change here can make a
graph wrong on screen; it can never make a backlog wrong.

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
- Use badges, real screenshots, statistics, and emoji only when they improve comprehension and can remain current.
- Preserve third-party licenses, copyright, attribution, and notices. Maintain `NOTICE.md` or the established attribution file when required.

## Configuration and repository hygiene

- Ignore secrets, local environments, logs, caches, build output, and generated artifacts appropriate to the actual stack.
- Configure dependency updates, CI, release workflows, a release channel, signing, and secure secret storage when distribution or project risk requires them. Do not add placeholder automation.
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
