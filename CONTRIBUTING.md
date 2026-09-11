# Contributing to Issues Graph

Thank you for taking the time. This is a small personal project, so the process is deliberately
light.

## Report a bug

Open an [issue](https://github.com/martonpaulo/issues-graph/issues) and include what you did, what
you expected, what happened, and the browser you used. The fastest thing you can give is the
**public `owner/repo` slug** that reproduces it, plus the issue numbers whose edges look wrong.

If the graph disagrees with GitHub, say which one you believe: this viewer only draws the native
`blocked by` and sub-issue relationships GitHub already tracks, so a missing edge is often a missing
relationship rather than a drawing bug.

Never paste a GitHub token, or any other credential, into an issue. The token the page accepts stays
in your own browser and should be revoked if it ever leaves it.

## Propose a change

Open an issue describing the problem before writing code, especially for anything that changes what
is read from the GitHub API, what is stored in the browser, or what a shared link carries.
[`docs/product.md`](docs/product.md) records the scope and the non-goals, and [`AGENTS.md`](AGENTS.md)
records the working agreements the repository follows. This repository reads and draws; it never
writes to GitHub, and a proposal that would change that is out of scope.

## Branches, commits and pull requests

- The owner commits validated work directly to `main`. Outside contributors work on a branch and
  open a pull request.
- Commit and pull request subjects follow [Conventional Commits](https://www.conventionalcommits.org/)
  in English: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`,
  `test`.
- One concern per commit. A commit or pull request made for an issue **ends with the issue numbers**:
  `feat(graph): add the export button (#54)`, `fix: normalize carriage returns (#54, #61)`.
- A pull request that closes issues starts its body with one `Closes #<n>` line per issue, and the
  title's numbers must name the same set.
- Pull requests are squash-merged, so the title becomes the commit subject on `main`.
- No force pushes.

## Run the validation gate

One command, running everything CI runs, in order:

```bash
npm ci
npm run validate
```

That is `typecheck`, `lint`, `test` and `build`. During iteration run the smallest relevant piece
instead — `npm run lint`, `npm test`.

`npm test` runs Vitest against the captured fixtures in `src/__fixtures__/`, so no network access and
no GitHub token are needed.

## Code of conduct

Be respectful and assume good faith. Behaviour that makes the project unpleasant for others is not
welcome, whatever its technical merit.
