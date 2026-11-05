---
title: "Kimi Hosted Agents vs OpenMA: Harness as a Service Compared | OpenMA"
description: "Kimi Hosted Agents runs the agent harness on Moonshot's cloud. How it compares to OpenMA, and how to move agents, MCP servers, and skills across."
publishedAt: 2026-11-05
author: openma
tags: ["kimi", "hosted-agents", "harness-as-a-service", "comparison", "migration", "self-hosted", "byok"]
---

Moonshot AI launched **Kimi Hosted Agents** (托管智能体) today and
describes it as **Harness as a Service**: the loop that calls the model,
runs tools, keeps history, and recovers from crashes runs on Kimi's
platform, and you configure agents and send events to it
([overview](https://platform.kimi.com/docs/hosted-agents/overview)).
The documentation lives on `platform.kimi.com` and is written in
Chinese. The English `platform.kimi.ai` docs currently cover only the
model inference API, so this post walks through the product in English
and compares it with OpenMA.

A short version: Kimi Hosted Agents and OpenMA belong to the same
category and use a surprisingly similar vocabulary. Kimi operates its
harness and runs Kimi models. OpenMA is an open-source runtime you can
run yourself, with any model provider you hold a key for, including Kimi.

## What Kimi Hosted Agents gives you

The resource model will look familiar if you have used
[Claude Managed Agents](/what-is-claude-managed-agents/):

- **Agents** are versioned configurations: model, system prompt, tools,
  MCP servers, skills, plugins, and an optional list of subagents. A
  session pins the agent version it was created with.
- **Sessions** start `idle` and begin work when you post a `user.message`
  event. History is stored server-side as an event log and streamed over
  SSE, with cursors for resuming after a disconnect
  ([event stream](https://platform.kimi.com/docs/hosted-agents/event-stream)).
- **Environments** describe the cloud sandbox (packages, networking,
  setup). Each session gets its own sandbox.
- **Vaults** hold third-party credentials and are bound when a session is
  created. MCP credentials are matched to servers by URL.
- **Skills** are `SKILL.md` bundles mounted read-only under
  `/mnt/agents/skills/<name>/`. **Plugins** package MCP servers and
  skills together, and Kimi's official plugins are billed per call.
- **Artifacts** are files the agent hands back with a `save_artifact`
  tool. There are also memory stores, a "dreams" feature that
  periodically consolidates memory, and cron-style triggers.

Kimi says the platform ships with 140+ skills, 30+ plugins, and 12
official agent templates, mostly for finance work, plus game, SRE, and
community-ops examples.

You reach it three ways. The `kha` CLI is the recommended path and is
designed to be driven from coding agents such as Kimi Code, Claude Code,
or Codex ([kha docs](https://platform.kimi.com/docs/hosted-agents/kha)).
There is a web console. And there is plain REST plus SSE at
`https://api.moonshot.cn/v1`, sent with a `kimi-api-version:
2026-09-01-beta` header. Kimi's migration guide says outright that no
SDK layer is required and any HTTP client works
([migration](https://platform.kimi.com/docs/hosted-agents/migration)).

Billing has three parts: sandbox time at ¥0.072 per hour, model tokens
at the chosen model's inference price, and per-call fees for plugins
([pricing](https://platform.kimi.com/docs/pricing/hosted-agents)).

## Side by side

| | Kimi Hosted Agents | OpenMA |
|---|---|---|
| Who runs the harness | Kimi, on its platform | You (self-host) or OpenMA hosted. The harness is open source and replaceable |
| Sessions and events | Server-side event log, SSE with cursor resume, `agent.delta` for token streaming | Event log written before broadcast, SSE or JSON polling, a crashed harness replays the log and resumes |
| Sandbox | Kimi cloud sandbox per session, or a self-hosted worker for enterprise-verified accounts | Pluggable providers: Docker, E2B, Daytona, Modal, Cloudflare, OpenSandbox, and others |
| MCP and skills | Remote MCP, `SKILL.md` skills, paid official plugins | Remote MCP, skills, vault-backed credential injection at an outbound proxy |
| Models | Kimi models | Any provider with a Model Card: Anthropic, OpenAI, DeepSeek, OpenRouter, Moonshot, custom endpoints |
| Billing | Sandbox hours + Kimi tokens + plugin calls | Self-hosted: your infrastructure, tokens paid to your provider. Hosted: sandbox compute ([pricing](/pricing/)) |
| What "self-hosted" means | Sandbox tools run on your host. Orchestration, model calls, and session state stay on Kimi | The whole control plane, database, and sandboxes run on infrastructure you choose |
| Client surface | `kha` CLI, console, Kimi-specific REST | Claude Managed Agents-shaped API at `/v1`, OpenAI Agents API adapter at `/openai/v1`, `oma` CLI, console |
| Source | Proprietary service | Apache 2.0 |

The self-hosted row deserves a closer look. Kimi's
[self-hosted environment](https://platform.kimi.com/docs/hosted-agents/self-hosted-environments)
runs a worker on your machine that polls for tool calls such as
`shell` and file edits. The agent loop stays in Kimi's cloud, and the
docs note that tool inputs and results still pass through Kimi's
inference service. In this mode `ipython` and `save_artifact` are not
available, and skills and memory are not mounted on the worker host. It
is the right shape when code has to execute next to internal systems
and the model call is allowed to leave.

## When Kimi Hosted Agents fits

- Your agents run on Kimi models and you want Moonshot to operate the
  runtime, including retries and crash takeover.
- The official finance plugins and templates match work you already do,
  and paying per call beats building those data integrations yourself.
- You already have a Kimi platform account and want agent runtime,
  tokens, and plugins billed through it.
- Your team likes driving infrastructure from a coding agent, which is
  what `kha install-skill` is built for.

## When OpenMA fits

- You want Kimi for some agents and Claude, GPT, or DeepSeek for others,
  with the choice made per agent.
- Session history, credentials, and outputs need to stay in a database
  and network you control, including the orchestration layer.
- You want to read, patch, or replace the harness, or run Kimi Code
  itself inside a managed sandbox through OpenMA's ACP runtime.
- Your clients already speak the Claude Managed Agents API or the OpenAI
  Agents API, and you want both against the same sessions.

## Migrating from Kimi Hosted Agents to OpenMA

Kimi Hosted Agents and OpenMA share most of their nouns, so most of the
move is a mapping exercise. OpenMA does not implement the Kimi Hosted
Agents wire protocol, so client code changes. Plan on rewriting the HTTP
layer and keeping your prompts, tools, and skills.

### 1. Take inventory

Export what you have with `kha` or the REST API: each agent's current
version (model, system prompt, tool config, MCP servers, skills,
plugins, subagent list), environments, vault credential types, memory
stores, and triggers. Note which agents depend on official plugins,
because those have no OpenMA counterpart and need replacing (step 5).

### 2. Map the resources

| Kimi Hosted Agents | OpenMA |
|---|---|
| Agent (versioned, pinned per session) | Agent (versioned, pinned per session) |
| Environment (cloud sandbox config) | Environment, plus the sandbox provider chosen by the deployment |
| `type: custom` tools → `agent.custom_tool_use` / `user.custom_tool_result` | Same event names, with `stop_reason.event_ids` on idle |
| `always_ask` tool permission → `user.tool_confirmation` | Same policy name and event |
| Remote MCP server + vault (`static_bearer`, `mcp_oauth`) | Remote MCP server + vault with the same two credential types |
| Skill bundle (`SKILL.md` + resources) | Skill uploaded to OpenMA and attached to the agent |
| Memory store | Memory store, mounted at `/mnt/memory/<store>/` |
| Coordinator + `spawn_subagent` | `callable_agents` on the parent agent |
| `save_artifact` | Files the agent writes to `/mnt/session/outputs`, listed at `GET /v1/sessions/:id/outputs` |
| Trigger | A scheduler of your choice that creates sessions over the API |

### 3. Map sessions and events

The event families line up closely: `user.message`, `user.interrupt`,
`agent.message`, `agent.thinking`, `agent.tool_use`, and
`agent.tool_result` exist on both sides. The differences that will break
a naive port are structural. Kimi wraps the payload in a `data` object
(`{"type": "user.message", "data": {"content": [...]}}`), while OpenMA
puts `content` on the event itself. Kimi's session states include
`stopping` and `interrupted`, and its subagents report on threads
identified by `session_thread_id`. Resume logic also differs: Kimi uses
`cursor` and `stream_cursor` values, so rewrite your reconnect code
against OpenMA's event stream rather than translating cursors.

A thin adapter in your own client (Kimi event in, OpenMA event out) is
usually less work than rewriting every consumer, and it lets you run
both backends side by side while you compare results.

### 4. Keep Kimi models, bring your own key

Leaving Kimi's harness does not require leaving Kimi models. The model
layer OpenMA builds on ships a `moonshotai-cn` provider pointed at
`https://api.moonshot.cn/v1`, so a Model Card can bind a Kimi model to
your own Moonshot API key:

```bash
curl -X POST "$OMA_BASE_URL/v1/oma/model_cards" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d '{
    "model_id": "kimi",
    "provider": "moonshotai-cn",
    "model": "kimi-k3",
    "api_key": "'"$KIMI_API_KEY"'"
  }'
```

Agents then reference it with `"model": { "id": "kimi" }`. For a model
the built-in catalog does not list yet, create the card with `base_url`
and `pi_config.api: "openai-completions"`, as described in the
[Model Cards reference](https://docs.openma.ai/reference/api/#model-cards).
Token charges then go straight to your Moonshot account.

### 5. Decide what does not come with you

- **Official plugins and their per-call data feeds.** Rebuild what you
  need with MCP servers or skills you own, or keep those agents on Kimi.
- **Dreams.** Memory stores move as files; the automatic consolidation
  does not. A scheduled agent that rewrites the store is the closest
  substitute.
- **Kimi Inference Hook**, the enterprise-only pre-inference security
  check. On OpenMA, equivalent policy lives in your own gateway or
  harness.
- **Platform sandbox pricing.** ¥0.072 per hour is Kimi's rate. On
  OpenMA the cost is whatever your chosen sandbox provider or hardware
  costs.
- **The official agent templates**, unless you copy their prompts and
  skills, which the template pages describe in detail.

### What about `kha`?

`kha` keeps a service address per profile and accepts a `--base-url`
override, which makes it tempting to point it at OpenMA. That will not
work today, because OpenMA does not serve the Kimi Hosted Agents API.
A compatibility layer is something we are investigating, and until it
ships, use the `oma` CLI or plain HTTP against OpenMA. We will update
this post if that changes.

## Where to go next

Start with the [OpenMA quickstart](https://docs.openma.ai/quickstart/)
or read [self-hosted AI agents](/self-hosted-ai-agents/) for the
reasoning behind running the control plane yourself. The neighbouring
comparisons cover the other hosted harnesses:
[OpenAI Agents API vs OpenMA](/blog/openai-agents-api-vs-openma/) and
[Claude Managed Agents vs OpenMA](/blog/claude-managed-agents-vs-open-managed-agents/).
For the full field of open-source runtimes, see
[open-source managed agents](/open-source-managed-agents/).
