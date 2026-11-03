---
title: "OpenAI Agents API vs OpenMA: Managed Runtimes | OpenMA"
description: "OpenAI Agents API vs Agents SDK vs OpenMA: who runs the agent loop, where sessions live, sandbox options, and when a multi-model runtime fits your team."
publishedAt: 2026-11-03
author: openma
tags: ["openai", "agents-api", "agents-sdk", "comparison", "self-hosted", "byok"]
---

"OpenAI agents" now names at least four different things: the
**Agents API**, the **Agents SDK**, **AgentKit**, and its visual
**Agent Builder**. They solve different problems, and most confusion
in reviews and tutorials comes from treating them as one. This post
maps the names, explains where durability fits, and compares the
OpenAI stack with Claude Managed Agents and with open, multi-model
managed runtimes such as OpenMA.

If you specifically want to self-host an OpenAI Agents API-compatible
endpoint, the hands-on guide is
[OpenAI Agents API: open-source options and self-hosting](/blog/openai-agents-api-self-hosted/).

## Naming map

| Name | What it is | Who runs the agent loop | Typical user |
|---|---|---|---|
| Agents API | OpenAI-managed agent runtime built on the Codex harness | OpenAI | Teams that want a hosted runtime on OpenAI models |
| Agents SDK | Open-source Python / TypeScript library for agent logic | Your application | Developers building agents in their own services |
| AgentKit | Toolkit: Agent Builder canvas, ChatKit UI, evals, connectors | OpenAI platform | Product teams prototyping and shipping agent workflows |
| Agent Builder | Visual workflow canvas inside AgentKit | OpenAI platform | Builders who prefer flows over code |

### Agents API

The [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview)
is OpenAI's managed runtime — the closest OpenAI equivalent to Claude
Managed Agents. OpenAI runs the Codex-based harness, stores sessions and
progress, and executes code in a hosted sandbox or a self-hosted sandbox
you connect. A self-hosted sandbox changes where code runs, not who
operates the API control plane.

### Agents SDK

The [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk)
is an open-source library. Agents, tools, handoffs, guardrails, and
tracing run inside your process. It is the OpenAI counterpart to the
[Claude Agent SDK](/blog/claude-agent-sdk-vs-managed-agents/): full
control of the loop, and everything operational — persistence,
sandboxing, recovery, scaling — is yours.

### AgentKit / Agent Builder

AgentKit bundles a visual Agent Builder, the embeddable ChatKit UI,
evaluation tooling, and a connector registry. It is aimed at getting a
workflow designed and in front of users quickly. A visual builder is a
good authoring surface, but it is not the same thing as a runtime you
operate: production agents still need tools with real permissions,
credentials, sandboxes, and policies. For the category view of
platforms vs SDKs vs builders, see the
[AI agent platform](/ai-agent-platform/) guide.

## Durable execution note

### Why Temporal appears on SDK SERPs

Search for the Agents SDK and you will find Temporal's integration
near the top. That is a signal about the SDK's scope: on its own, an
in-process SDK run lives and dies with the process. Temporal adds
durable execution — workflows and activities that survive crashes and
retries — around SDK agents.

A managed runtime provides the same property differently: every input,
output, and tool call is written to a durable session log, and a new
harness resumes from it. Whether you choose the SDK plus a workflow
engine or a managed runtime depends on whether you want to operate the
durability layer yourself.

## Themes from reviews

### Migration

A recurring point in Agents API reviews: it provides a managed Codex
harness, not a replacement for your business permissions or access
controls — those, and your data stores, stay your responsibility when
you migrate onto it. OpenAI also
publishes a cookbook guide for moving from the Claude Agent SDK to the
OpenAI Agents SDK — a vendor switch at the SDK layer, not a move to a
managed runtime.

### Cost

The managed API is billed separately from model tokens, and its runtime
and sandbox components should be checked against
[OpenAI's current pricing](https://openai.com/api/pricing/) rather than
assumed. The SDK adds your own compute and operations. Compare cost per
completed task, not per request — agents loop, retry, and call tools.

### Data control

With the Agents API, sessions and progress live with OpenAI. With the
SDK, they live wherever your application stores them. Regulated teams
usually care less about the label "open source" than about where
session history, tool output, and credentials are stored.

## Compare to Claude Managed Agents

| | OpenAI Agents API | Claude Managed Agents |
|---|---|---|
| Harness | Codex harness, OpenAI-operated | Anthropic harness, Anthropic-operated |
| Models | OpenAI | Claude |
| Sessions | Hosted, durable | Hosted, durable |
| Sandbox | Hosted or self-hosted sandbox | Cloud sandbox or self-hosted sandbox |
| Control plane | OpenAI | Anthropic |
| Pricing shape | Tokens + runtime and sandbox usage (see [OpenAI pricing](https://openai.com/api/pricing/)) | Tokens + $0.08 per running session-hour |

The two are close peers. Each is the fastest path to production on its
vendor's models, and each ties the control plane to that vendor. See
[what is Claude Managed Agents](/what-is-claude-managed-agents/) and
[Claude Managed Agents pricing](/blog/claude-managed-agents-pricing/) for
the Anthropic side.

## Compare to OpenMA

OpenMA is an open-source managed agent runtime with two API contracts
over the same native sessions:

- a Claude Managed Agents-compatible API at `/v1`, and
- an OpenAI Agents API-compatible endpoint at `/openai/v1`, usable with
  the official OpenAI SDK.

| | OpenAI Agents API | OpenAI Agents SDK | OpenMA |
|---|---|---|---|
| Who runs the loop | OpenAI | Your process | OpenMA (self-hosted or hosted) |
| Models | OpenAI | OpenAI-first | Any configured provider, per agent |
| Durable sessions | Yes | Add your own (e.g. a workflow engine) | Yes — event-sourced |
| Sandbox | Hosted or self-hosted | Yours | Replaceable drivers (Docker, E2B, Daytona, Modal, Cloudflare, …) |
| Self-host control plane | No | N/A (library) | Yes |
| Source | Proprietary service | Open source | Apache 2.0 |

OpenMA's OpenAI adapter does not reproduce every behavior of OpenAI's
service, and coverage differs between Node and Cloudflare runtimes. The
[compatibility report](https://github.com/openma-ai/open-managed-agents/blob/main/docs/openai-agents-compatibility-status.md)
lists what is supported; the
[self-hosting guide](/blog/openai-agents-api-self-hosted/) walks through
a working setup.

## When an OpenAI-only stack is enough

- Your agents run on OpenAI models and will for the foreseeable future.
- OpenAI-hosted session data fits your compliance posture.
- You want the Codex harness and the newest OpenAI features first.
- For a single embedded agent, the Agents SDK in your own service is
  simpler than any platform.

## When you want a multi-model managed runtime

- Different agents should run on different vendors' models, or you need
  a fallback provider.
- Session history, credentials, and outputs must stay on your
  infrastructure.
- You want both OpenAI-style and Claude Managed Agents-style clients
  against the same sessions.
- You want to choose the sandbox provider and read or replace the
  harness.

Need OpenAI-only? Stay on the API or SDK. Need multi-model and a
self-hosted managed runtime? Start with the
[OpenMA docs](https://docs.openma.ai/), read about
[self-hosted AI agents](/self-hosted-ai-agents/), or compare the wider
field in the [Claude Managed Agents alternative](/claude-managed-agents-alternative/)
guide.
