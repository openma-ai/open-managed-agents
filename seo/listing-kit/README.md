# OpenMA listing kit

Shared copy and assets for directory and launch submissions (issue #482). Reuse the text as-is and pick the length a form allows. Facts were checked against `README.md`, `apps/web/src/pages/index.astro` and the GitHub repo metadata on 2026-11-07. If the product changes, update this file first.

## Basics

| Field | Value |
|---|---|
| Name | Open Managed Agents |
| Short name | OpenMA |
| Website | https://openma.ai |
| Docs | https://docs.openma.ai |
| GitHub | https://github.com/openma-ai/open-managed-agents |
| Hosted app | https://app.openma.ai |
| Discord | https://discord.gg/P3EfQFm5bD |
| License | Apache-2.0 (open source) |
| Pricing model | Free and open source; optional hosted service (Free / $20 / $100 per month, BYOK models, billed for sandbox compute) |
| Self-hostable | Yes: Node.js, Docker, Fly.io, Render, Vercel (beta), Cloudflare |
| Platforms | Web (Console), CLI (`oma`), TypeScript SDK, REST API |
| First public release | April 2026 (GitHub repo created 2026-04-10) |
| X / Twitter | None. Do not use `@openma_dev`; it was never registered. |

## Taglines

| Length | Text | Chars |
|---|---|---|
| ≤ 60 (recommended) | Open-source alternative to Claude Managed Agents | 48 |
| ≤ 60 | Run Claude and OpenAI agents on your own infrastructure | 55 |
| ≤ 60 (brand line) | Any model. Any harness. Any sandbox. Any cloud. | 47 |
| ≤ 120 | Open-source runtime for Claude Managed Agents and OpenAI Agents API workloads. Hosted or self-hosted, with BYOK models. | 119 |

## Descriptions

**≤ 160 characters** (154)

> OpenMA runs Claude Managed Agents and OpenAI Agents API workloads on your own infrastructure: durable sessions, sandboxes, tools, BYOK models. Apache-2.0.

**≤ 300 characters** (299)

> Open Managed Agents (OpenMA) handles sessions, execution and recovery for AI agents. Use the Claude Managed Agents or OpenAI Agents SDKs you know, bring your own model keys, and choose the harness, sandbox and cloud. Self-host on Node.js, Docker or Cloudflare, or use the hosted service. Apache-2.0.

**Long (~400 words)**

Open Managed Agents (OpenMA) is an open-source platform for running AI agents on infrastructure you control. It handles sessions, execution and recovery, so you can build and run agents with any model, any harness, any sandbox, on any cloud. It is an open-source, self-hostable alternative to Claude Managed Agents and OpenAI Agents API, licensed under Apache-2.0.

**Use the SDKs you already know.** OpenMA exposes a Claude Managed Agents–compatible API (`/v1/*`), checked with contract tests and end-to-end runs through the official Anthropic SDK, and an OpenAI Agents API adapter (`/openai/v1/*`) that maps OpenAI SDK calls onto native OpenMA agents and sessions. An experimental Kimi Hosted Agents subset is available on the Node server.

**Durable sessions and recovery.** Every session owns an append-only event log. Conversation history and progress survive restarts, clients can stream events in real time, and a new harness instance can rebuild context from the log and continue. Workspace checkpoints and retained outputs support recovery with the configured runtime.

**Choose each layer independently.**

- Models: Anthropic, OpenAI, DeepSeek, OpenRouter and custom endpoints through Model Cards. Bring your own keys.
- Harnesses: the built-in harness; Claude Code, Codex and other agents through ACP adapters; or your own harness.
- Sandboxes: E2B, Daytona, LiteBox, Cloudflare Sandbox and more.
- Storage and queues: SQLite, PostgreSQL, MySQL or Cloudflare D1; S3-compatible storage or Cloudflare R2.

**Tools and integrations.** Agents start with shell, file, web and browser tools. Add MCP servers and Skills, and publish an agent into Slack, GitHub, Linear or Feishu, each publication with its own app identity and scopes. Model Cards encrypt provider keys at rest, and vault-backed gateways give agents scoped access to private services.

**Deploy where you want.** Self-host on native Node.js, Docker, Fly.io, Render, Vercel (beta) or Cloudflare, or install the deployment skill and ask your coding agent to deploy it. Operate through the Console, the `oma` CLI, the TypeScript SDK or the REST API.

**Pricing.** Self-hosting is free. The optional hosted service at app.openma.ai is BYOK for models and charges only for sandbox compute: Free ($1 one-time trial credit), Pro ($20/month) and Max ($100/month).

**Who it is for.** Platform and product teams that want a managed-agents runtime without tying sessions, credentials, logs and sandbox output to one vendor's cloud, and developers building agents that work inside Slack, GitHub or Linear. OpenMA is not a coding agent or a no-code builder; it is the runtime layer underneath them.

## "Alternative to" entries

Only list products where OpenMA serves the same job. Do not list coding agents (Devin, Cursor) as things OpenMA replaces.

- Claude Managed Agents (Anthropic): primary
- OpenAI Agents API
- Kimi Hosted Agents (experimental subset only; say so if the form allows notes)

## Tags / categories

AI agents, agent platform, agent runtime, developer tools, open source, self-hosted, Claude Managed Agents, OpenAI Agents API, MCP, sandbox, BYOK, Cloudflare, TypeScript

## Assets

| Asset | Path | Size |
|---|---|---|
| Logo, square, white background | `seo/listing-kit/logo/openma-logo-{256,512,1024}-white.png` | 256 / 512 / 1024 px |
| Logo, square, transparent | `seo/listing-kit/logo/openma-logo-{256,512,1024}-transparent.png` | 256 / 512 / 1024 px |
| Logo, vector | `seo/listing-kit/logo/openma-logo.svg` | — |
| Screenshot: agent configuration | `docs/assets/console/agent-light.png` | 1440×1080 |
| Screenshot: model setup | `docs/assets/console/model-setup-light.png` | 1440×1080 |
| Screenshot: environment | `docs/assets/console/environment-light.png` | 1440×1080 |
| Social / cover image | `apps/web/public/og-default.png` | 1200×630 |

Console screenshots use synthetic demo data (see `docs/assets/console/README.md`).

## Per-directory notes

| Directory | Issue | Submit URL | Notes |
|---|---|---|---|
| DevHunt | #473 | https://devhunt.org/account/tools/new | Developer tools, AI. Use the ≤60 tagline. |
| OpenAlternative | #474 | https://openalternative.co/submit | Alternative to Claude Managed Agents. Picks up stars/license from GitHub. |
| OpenSourceAlternative.to | #475 | https://www.opensourcealternative.to/submit | Alternative to Claude Managed Agents, OpenAI Agents API. |
| SaaSHub | #477 | https://www.saashub.com/services/submit/ | AI agents, developer tools. Mark as open source. |
| StackShare | #478 | https://stackshare.io/tools/new | Category close to "AI agent platform" / "Agent frameworks". |
| AI Agents List | #480 | https://aiagentslist.com/submit | Agent platform / developer tools; open source. |
| awesome-ai-agents | #479 | PR to https://github.com/e2b-dev/awesome-ai-agents (or their form) | Entry below; alphabetical, right after "Open Interpreter" in "Open-source projects". |
| Show HN | #471 | https://news.ycombinator.com/submit | Needs the maintainer present for Q&A; not part of this batch. |
| Product Hunt | #472 | https://www.producthunt.com/ | Needs a launch plan; not part of this batch. |

Record each live listing URL in its issue when done.

## awesome-ai-agents entry

```markdown
## [Open Managed Agents](https://github.com/openma-ai/open-managed-agents)
Open-source, self-hostable runtime for Claude Managed Agents and OpenAI Agents API workloads

<details>

![Image](https://openma.ai/logo.png)

### Category
Build-your-own, General purpose, Supports open-source models

### Description

- **SDK-compatible APIs**: Claude Managed Agents–compatible `/v1` API and an OpenAI Agents API adapter.
- **Durable sessions**: append-only event log per session; history and progress survive restarts.
- **Any model, harness and sandbox**: BYOK model cards, ACP harness adapters (Claude Code, Codex), and sandboxes such as E2B, Daytona and Cloudflare.
- **Integrations**: MCP servers, Skills, and per-agent Slack, GitHub, Linear and Feishu publications.
- **Self-host anywhere**: Node.js, Docker, Fly.io, Render, Vercel (beta) or Cloudflare; Apache-2.0.

### Links
- [Website](https://openma.ai/)
- [Documentation](https://docs.openma.ai/)
- [Discord](https://discord.gg/P3EfQFm5bD)
- [GitHub](https://github.com/openma-ai/open-managed-agents)
</details>
```
