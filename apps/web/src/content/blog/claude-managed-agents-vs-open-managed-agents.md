---
title: "Claude Managed Agents vs OpenMA: 1:1 Comparison | OpenMA"
description: "Claude Managed Agents vs OpenMA compared 1:1: models, hosting, sessions, sandboxes, credentials, and cost shape — with clear guidance on when each wins."
publishedAt: 2026-05-09
updatedAt: 2026-11-03
author: openma
tags: ["comparison", "claude", "managed-agents", "self-hosted", "architecture"]
---

A managed agent runtime owns sessions, sandboxes, tool dispatch, and
crash recovery so your team does not have to. Two options share almost the same outer shape:
**Claude Managed Agents** (CMA), Anthropic's hosted service, and
**OpenMA** (Open Managed Agents), an Apache-2.0 runtime you can self-host
or use hosted. Both expose agents, environments, sessions, and an event
stream. What differs is who runs the control plane, which models you can
use, and how the bill is shaped.

Other options are compared in
[Claude Managed Agents alternative](/claude-managed-agents-alternative/).
For a primer on the hosted product, read
[what is Claude Managed Agents](/what-is-claude-managed-agents/).

## The two products at a glance

| | Claude Managed Agents | OpenMA |
|---|---|---|
| What it is | Anthropic-hosted agent harness + runtime | Open-source managed agent runtime (meta-harness) |
| Who runs the control plane | Anthropic | You (self-host) or OpenMA hosted |
| Models | Claude | Claude, OpenAI, DeepSeek, OpenRouter, custom endpoints via Model Cards |
| License | Proprietary | Apache 2.0 |
| API | `/v1/agents`, `/v1/environments`, `/v1/sessions`, events | Same resource shape at `/v1`, plus an OpenAI Agents API adapter at `/openai/v1` |



## Feature matrix

### Model choice: Claude-only vs multi-model

**Claude Managed Agents** runs Claude models. That is a feature if Claude
is your standard and you want Anthropic to tune the harness for it.

**OpenMA** separates the model from the runtime. Each agent references a
model (or a Model Card for a custom provider or gateway), so one agent can
run on Claude and another on an OpenAI or OpenRouter model. Provider keys
are encrypted at rest in Model Cards. The "brain and hands" split also
lets you swap the model vendor without touching the runtime.

### Hosting: Anthropic cloud vs self-host

**Claude Managed Agents** runs the harness and session state on
Anthropic-operated infrastructure, also when you use it through Claude
Platform on AWS or Google Cloud. Its docs describe self-hosted sandboxes
for tool execution, and the agent loop and control plane stay with
Anthropic ([CMA overview](https://platform.claude.com/docs/en/managed-agents/overview)).

**OpenMA** runs wherever you deploy it: Node.js or Docker, Fly.io,
Vercel (beta), or Cloudflare. Session history lives in your database
(SQLite, PostgreSQL, MySQL, or Cloudflare D1 / Durable Object SQL), and
workspace blobs in S3-compatible storage or R2. See
[self-hosted AI agents](/self-hosted-ai-agents/) for why teams choose that
path.

### API, sessions, sandbox, observability, multi-tenancy

| Area | Claude Managed Agents | OpenMA |
|---|---|---|
| Session model | Hosted, long-running sessions with an event stream | Durable sessions stored as an event log, so a crashed run resumes where it stopped |
| Event stream | SSE (`agent.message`, `agent.tool_use`, `session.status_idle`, …) | Same event families over SSE or JSON polling |
| Harness | Anthropic's harness, not modifiable | Built-in Pi harness, ACP adapters for Claude Code / Codex, or your own |
| Sandbox | Anthropic cloud sandboxes; self-hosted sandbox option | Replaceable drivers: Docker, E2B, Daytona, Modal, Sprites, Vercel, Blaxel, BoxLite, Cloudflare, and more |
| Credentials | Vaults managed by Anthropic | Vaults with injection at an outbound proxy. Enforcement depends on the sandbox provider and runtime profile |
| Observability | Event history persisted server-side and fetchable through the API | Event log in your own database, viewable in the OpenMA Console |
| Multi-tenancy | Scoped to your Anthropic organization | Tenants in your own deployment |
| Workplace integrations | MCP servers | MCP plus GitHub, Linear, Slack, and Feishu integrations |

**API compatibility.** OpenMA keeps the Claude Managed Agents resource
shape on purpose, so most client code moves by changing the base URL:

```diff
- const client = new Anthropic({ baseURL: "https://api.anthropic.com" });
+ const client = new Anthropic({ baseURL: "http://localhost:8787" });
```

Coverage is tracked surface by surface in the
[Claude Managed Agents compatibility matrix](https://docs.openma.ai/claude-managed-agents-compatibility/).
Check it for each endpoint you depend on.

**Who owns the loop.** In CMA, decisions about context engineering,
caching, compaction, and tool retries happen inside a harness you cannot
see. OpenMA splits the stack:

```
┌─────────────────────────────────────────────────────────┐
│  Harness (the brain — default or your own)              │
│  - Reads events, builds context, calls the model        │
│  - Stateless: crash → rebuild from event log → resume   │
├─────────────────────────────────────────────────────────┤
│  Meta-harness (the platform)                            │
│  - Tools, skills, history, sandbox lifecycle            │
│  - Crash recovery, credential isolation, usage tracking │
├─────────────────────────────────────────────────────────┤
│  Infrastructure (Cloudflare, or Node + SQL + storage)   │
└─────────────────────────────────────────────────────────┘
```

Every input and output is appended to a per-session event log before it
is broadcast. When a harness crashes, the next one replays the log and
continues. That property is also what makes the harness swappable.

**Sandbox swaps.** OpenMA picks the sandbox provider per deployment in
configuration, and the Session API stays the same across providers.
The [sandbox guide](https://docs.openma.ai/sandboxes/) maps each driver's
isolation and suspend/resume behavior.

## When Claude Managed Agents wins



- You are standardized on Claude and want Anthropic to own harness tuning.
- You want zero infrastructure decisions and no on-call for the runtime.
- Anthropic-hosted data processing fits your compliance posture.
- You need features the moment Anthropic ships them.
- Session-hour plus token pricing fits your usage shape.

## When OpenMA wins

- You need **more than one model vendor**, or want to route agents to
  different models by task or cost.
- **Data residency** or audit rules require session history, credentials,
  and outputs to stay on infrastructure you control.
- You want to **read, fork, or replace the harness** for custom context
  engineering, caching breakpoints, or bringing Claude Code / Codex into
  a managed sandbox via ACP.
- You want to choose the sandbox provider and backend services.
- You want an OpenAI Agents API endpoint and a Claude Managed Agents
  endpoint over the same sessions.



## Cost shape

The two bills are structured differently:

| | Claude Managed Agents | OpenMA self-hosted | OpenMA hosted |
|---|---|---|---|
| Runtime | Session-hour fee while a session is running | Your infrastructure cost | Wallet-based cloud sandbox compute |
| Model tokens | Anthropic token rates | Paid directly to your provider (BYOK) | Paid directly to your provider (BYOK) |
| Platform fee | Included in session runtime | None | None. You pay for sandbox compute ([pricing](/pricing/)) |

For the billable components, easy-to-miss spend, and a worked monthly
example, see
[Claude Managed Agents pricing](/blog/claude-managed-agents-pricing/).
Self-hosting moves cost from a vendor line item to infrastructure and
operations you own, and whether that is cheaper depends on your usage.

## Trying OpenMA with an existing CMA client

1. Confirm the endpoints you rely on in the
   [compatibility matrix](https://docs.openma.ai/claude-managed-agents-compatibility/).
2. Run OpenMA locally:

   ```bash
   git clone https://github.com/openma-ai/open-managed-agents
   cd open-managed-agents
   cp .env.example .env   # add a model provider key
   docker compose up -d
   ```

3. Point your existing client at it, then follow
   [migrating from Claude Managed Agents](/blog/migrate-from-claude-managed-agents/)
   for vaults, sessions, and integrations.


