# Product definition — issues-graph

One page. What this is, who it serves, and what it will not do. Individual requirements and
acceptance criteria live in issues, not here.

## What it is

A hosted page that draws a GitHub repository's open issues and the blocking order between them as a
graph. You give it an owner and a repository; it reads the native `blocked by` relationships GitHub
already tracks and renders them.

```
https://martonpaulo.github.io/issues-graph/dependencies/<owner>/<repo>
```

It is one of three repositories that divide this work. [`martonpaulo/skills`](https://github.com/martonpaulo/skills)
holds the agent skills that create and verify the dependencies; GitHub holds them;
[`martonpaulo/agent-workflows`](https://github.com/martonpaulo/agent-workflows) is the execution
engine that acts on issues. This repository only renders. It is the last step in that chain and the
only one with no authority.

## Who it is for

Marton Paulo's own repositories first, and anyone who keeps a backlog in GitHub Issues and uses
native issue dependencies. The reader is somebody deciding what to pick up next, or explaining to
somebody else why a piece of work cannot start yet.

## The job

GitHub records `blocked by` accurately and shows it one issue at a time. That is enough to answer
"is this one blocked" and useless for answering "what does the backlog actually look like" — which
issue unlocks the most, where the chain is deepest, what could be started right now. Reconstructing
that shape from a list means opening issues one by one and holding the graph in your head.

The workaround people reach for is generating a diagram file into the repository and regenerating it
after every change. That works and it costs a maintained artifact, a regeneration step somebody has
to remember, and a file that is wrong between the change and the regeneration. This reads GitHub on
demand instead and leaves nothing in the repository. A fresh read reflects GitHub at that moment; a
saved browser copy stays explicitly identified by its age and dependency coverage.

## What it does

- Renders the open issues of any public repository and the blocking edges between them, laid out so
  the chains and the roots are legible rather than merely drawn.
- Draws the native sub-issue hierarchy as a second, visibly different relation, because containment
  and ordering answer different questions and one edge style cannot carry both.
- Says what will actually happen to each issue next, in words on the card, from the labels,
  assignees and dependency counts GitHub already holds. An issue whose change is written and
  waiting on a review must never read as one to pick up.
- Makes the reading aids local to the reader: selecting, hiding, and highlighting change what you
  see and nothing else.
- Keeps closed blockers available behind a switch, because the reason an issue is unblocked is often
  the thing you need to see.
- Quotes each read against the unauthenticated request budget and confirms it before spending it,
  then saves it in the reader's own browser. Later visits explicitly choose between a fresh read and
  that free saved copy, whose canvas shows when it was saved and whether it includes closed blockers.

## What it will never do

- **Write to GitHub.** Not a label, not a comment, not a dependency. A viewer that can change what it
  displays stops being a viewer, and the whole reason it needs no token is that it never needs one.
- **Be authoritative for dependency data.** GitHub's `blockedBy` and `blocking` are the source of
  truth. Deleting this repository would lose a view, never a fact — and that is the property that
  makes it safe to depend on lightly.
- **Require anything in the repository it renders.** No generated graph file, no workflow, no
  configuration. The moment it needs an artifact installed somewhere, it inherits that artifact's
  staleness and the obligation to regenerate it, which is the problem it exists to remove.
- **Hold server-side state.** There is no backend to secure, to pay for, or to migrate. What it
  remembers lives in the reader's browser and is theirs to clear.
- **Read private repositories.** That would require a token, and a page that asks for a GitHub token
  is asking readers to trust a static site with credentials. Unauthenticated is the boundary, not a
  limitation waiting to be lifted.
- **Become a project management tool.** No planning, no editing, no board. Those live in GitHub and
  in `skills`, and a viewer that grows opinions about process is a second place where process is
  decided.

## How you know it worked

You can answer "what should I start next, and why" from the graph alone, without opening the issue
list beside it. If the graph has to be checked against the backlog to be trusted, it has failed at
the only job it has.

## Constraints

- **The unauthenticated GitHub REST budget**, shared per IP. It is the binding constraint on how
  much a page may read, which is why reads are quoted before they are spent and cached after.
- **Static hosting only**, on GitHub Pages. No server, no build-time data, no scheduled job.
- **The browser is the whole runtime.** Everything the page knows, it fetched itself, in the session
  the reader is looking at or an earlier session that produced the explicitly identified saved copy.
