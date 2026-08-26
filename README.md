# issues-graph

A hosted dependency graph for GitHub Issues. Point it at any public repository and it renders that
repository's open issues and the native `blocked by` relationships between them, as a graph you can
read.

```
https://martonpaulo.github.io/issues-graph/dependencies/<owner>/<repo>
```

It is a static page. There is no backend, no token, and no generated graph file in the repository
being rendered — every read goes straight to the public GitHub REST API from the browser, and the
`blocked by` / `blocking` relationships GitHub already tracks are the only source of truth for the
edges.

## Related repositories

Three repositories divide this work, and the boundary between them is deliberate:

| Repository | Owns |
| --- | --- |
| [`martonpaulo/skills`](https://github.com/martonpaulo/skills) | The agent skills that capture, plan, groom and implement issues — including the ones that **create and verify** the GitHub issue dependencies this viewer renders |
| [`martonpaulo/agent-workflows`](https://github.com/martonpaulo/agent-workflows) | The reusable GitHub Actions engine that lets AI agents implement issues and review pull requests, driven by GitHub Projects |
| **`martonpaulo/issues-graph`** (this one) | The visualization. It reads; it never writes |

The data flows one way, and this repository is the last step:

```
skills                    creates and verifies dependencies
   ↓
GitHub native issue relationships          the source of truth
   ↓
issues-graph                               renders them
```

This viewer is not authoritative for anything. Deleting it would lose a view, never a fact.

## Running it locally

```bash
npm ci
npm run dev
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build into `dist/` |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm test` | Vitest, against captured API fixtures |

Tests run against fixtures captured from the live API by `scripts/capture-fixtures.mjs`. Capture a
payload rather than hand-writing one — a hand-written payload asserts what somebody assumed the API
returns.

## History

Extracted from [`martonpaulo/agent-workflows`](https://github.com/martonpaulo/agent-workflows), where
it lived as `web/`, so that repository stays what its name says it is. The commit history came with
it.

## Status

Repository policy, identity, license and GitHub metadata are still to be established by
`project-setup`. This README covers what the project is and how to run it; it is not yet the
project's canonical guidance.
