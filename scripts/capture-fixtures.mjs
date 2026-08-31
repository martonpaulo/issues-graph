#!/usr/bin/env node
/**
 * Refreshes the test fixtures from the live GitHub API.
 *
 *   node scripts/capture-fixtures.mjs martonpaulo/agent-workflows martonpaulo/tabelo
 *
 * Full issue payloads run to hundreds of kilobytes per repository, so the issue lists are
 * projected down to the fields the client actually consumes. To keep that projection honest each
 * repository also stores one complete, unprojected issue payload (its body removed, since bodies
 * are unbounded prose) which the tests parse to prove the projection never drops a consumed field.
 *
 * Requires the `gh` CLI, authenticated. The viewer itself needs no token.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIXTURES = fileURLToPath(new URL('../src/__fixtures__/', import.meta.url))

/** Mirrors the client: every page, 100 at a time. */
const paginate = (path) =>
  JSON.parse(
    execFileSync('gh', ['api', '--paginate', '--slurp', path], { maxBuffer: 64 * 1024 * 1024 }),
  ).flat()

/** Mirrors the client: paginated, open issues only. */
const listIssues = (slug) => paginate(`repos/${slug}/issues?per_page=100&state=open`)

/**
 * Mirrors the client again: `blocked_by` defaults to 30 per page, so a fixture captured from one
 * unpaginated request would record the truncation the client was fixed to stop making.
 */
const listBlockedBy = (slug, number) =>
  paginate(`repos/${slug}/issues/${number}/dependencies/blocked_by?per_page=100`)

/** Exactly the fields `github.ts` reads. Anything else is noise in a fixture. */
const project = (issue) => ({
  number: issue.number,
  title: issue.title,
  state: issue.state,
  state_reason: issue.state_reason,
  html_url: issue.html_url,
  repository_url: issue.repository_url,
  labels: (issue.labels ?? []).map((label) => ({ name: label.name, color: label.color })),
  issue_dependencies_summary: issue.issue_dependencies_summary,
})

for (const slug of process.argv.slice(2)) {
  const name = slug.split('/')[1]
  const raw = listIssues(slug).filter((i) => !i.pull_request)

  const blockedBy = {}
  for (const issue of raw) {
    if ((issue.issue_dependencies_summary?.total_blocked_by ?? 0) > 0) {
      blockedBy[issue.number] = listBlockedBy(slug, issue.number).map(project)
    }
  }

  const sample = { ...raw[0], body: null }

  writeFileSync(`${FIXTURES}${name}.issues.json`, `${JSON.stringify(raw.map(project), null, 1)}\n`)
  writeFileSync(`${FIXTURES}${name}.blocked-by.json`, `${JSON.stringify(blockedBy, null, 1)}\n`)
  writeFileSync(`${FIXTURES}${name}.raw-issue.json`, `${JSON.stringify(sample, null, 1)}\n`)

  console.log(`${slug}: ${raw.length} issues, ${Object.keys(blockedBy).length} with blockers`)
}
