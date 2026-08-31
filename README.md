# issues-graph

A hosted dependency graph for GitHub Issues. Point it at any public repository and it renders that
repository's open issues and the native `blocked by` relationships between them, as a graph you can
read.

```
https://martonpaulo.github.io/issues-graph/dependencies/<owner>/<repo>
```

It is a static page. There is no backend, no credential of its own, and no generated graph file in
the repository being rendered — every read goes straight to the public GitHub REST API from the
browser, and the `blocked by` / `blocking` relationships GitHub already tracks are the only source
of truth for the edges.

## Rate limit

Unauthenticated GitHub requests share 60 per hour per IP address, and reading a repository costs
one request per 100 issues plus one per issue that has blockers. The page tells you what a read
will cost before it spends anything.

If that is not enough, open **GitHub token** on the start screen and paste your own
[fine-grained personal access token](https://github.com/settings/personal-access-tokens); read
access to public repositories is all it needs. The limit becomes 5000 per hour.

The token is yours, not this page's:

- it is kept in your browser's `localStorage`, on your device only;
- it is sent only to `api.github.com`, in the `Authorization` header, never in a URL;
- **Remove** deletes it, and the page goes back to reading unauthenticated.

Nothing is registered under this repository's owner, and no token is ever committed here. Anyone
who can run scripts in your browser on this origin can read what `localStorage` holds, so use a
token scoped to public reads and revoke it when you are done.

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

## Versioning

There is none, deliberately. Nothing pins this repository, so there is no compatibility contract a
version number could describe: `main` is what is deployed. Git history is the record.
[`AGENTS.md`](AGENTS.md) carries the full policy and [`docs/product.md`](docs/product.md) says what
this is and what it will never do.

