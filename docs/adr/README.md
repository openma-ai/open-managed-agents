# Architecture Decision Records

An ADR records one architectural decision: the context that forced it, what
was decided, and what it costs. It is short and it is not a research report.
Surveys, competitor matrices and measurements live elsewhere (an issue, a
gist, `docs/`) and are linked from the ADR.

## When to write one

Write an ADR before (or together with) the first PR that does any of these:

- changes a contract between packages or runtimes (ports, Session Execution,
  sandbox/provider lifecycle, event semantics);
- changes behaviour visible through the public API (`/v1/*`, SDK, CLI) in a
  way clients can observe — ordering, timing, error shape, defaults;
- makes a decision that is expensive to reverse (storage layout, security or
  credential boundaries, a new external dependency that owns state);
- resolves a design question that has been argued in more than one issue.

Bug fixes, refactors that keep contracts, and feature work that fits an
existing ADR do not need a new one.

## Three layers for a large topic

| Layer | Holds | Lives in |
|---|---|---|
| Research | surveys, comparisons, measurements | issue comments, gist, `docs/` |
| Decision | context, decision, consequences, alternatives | `docs/adr/NNNN-*.md` (this directory) |
| Delivery | sub-tasks, PRs, acceptance | a tracking issue with sub-issues |

A large topic gets one tracking issue. The tracking issue links the ADR; the
ADR links the tracking issue. Discussion of the decision itself happens on the
ADR pull request, where comments attach to the exact paragraph.

## Lifecycle

```
Proposed ──► Accepted ──► Superseded by NNNN
    │            └──────► Deprecated
    └──────► Rejected
```

- **Proposed** — open for discussion. May be merged to `main` so that later
  work can link it, but only if the header names an **Owner** and a
  **Tracking** issue. A Proposed ADR does not authorize implementation that
  contradicts an Accepted one.
- **Accepted** — the decision holds. Implementation progress is tracked in
  the tracking issue, not in the Status line; do not write
  "Accepted and partially implemented".
- **Rejected** — kept in place so the reasoning is not lost.
- **Superseded by NNNN** / **Deprecated** — the body is not rewritten.
  Corrections that do not change the decision (typos, links, code paths) are
  fine.

Changing an Accepted decision means a new ADR that supersedes it, and an
edit of the old header to `Superseded by NNNN`.

## Process

1. Copy [`template.md`](template.md) to `NNNN-short-title.md`, using the next
   free number (check open PRs touching `docs/adr/` to avoid collisions).
2. Open a PR containing only the ADR (plus this index). Link it from the
   tracking issue.
3. Reviewers comment on the PR. The Owner resolves comments and updates
   Status in the same PR (`Accepted` / `Rejected`), or merges it as
   `Proposed` under the rule above.
4. Implementation PRs reference the ADR (for example `ADR 0006`) in their description.

## Index

Numbers 0001–0003 and 0012 are not used in this repository.

| ADR | Title | Status |
|---|---|---|
| [0004](0004-feishu-integration.md) | Feishu integration — mirror Slack's publication-first install | Accepted |
| [0005](0005-self-hosted-worker-runtime-resources.md) | AMA-compatible workers with provider-neutral runtime resources | Accepted |
| [0006](0006-session-execution-authority.md) | One fenced execution authority for Session turns | Accepted |
| [0007](0007-sandbox-credential-egress.md) | Fenced credential egress for managed runtimes | Accepted |
| [0008](0008-provider-environment-worker-installations.md) | Embedded provider drivers and the external Worker boundary | Accepted |
| [0009](0009-github-bonds.md) | GitHub Bonds, repository picking, and execution principals | Proposed |
| [0010](0010-gitlab-bonds.md) | Self-managed GitLab Bonds, user principal by default | Proposed |
| [0011](0011-matter-bond-and-loop.md) | Matter, Bond and Loop in OMA, starting with GitLab and Feishu | Proposed |
| [0013](0013-retire-legacy-oma-resource-stack.md) | Retire the legacy OMA resource stack | Proposed |
