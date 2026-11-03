---
title: "OpenAI Agents API vs OpenMA: Managed Runtimes | OpenMA"
description: "OpenAI Agents API vs Agents SDK vs OpenMA: who runs the agent loop, where sessions live, sandbox options, and when a multi-model runtime fits your team."
publishedAt: 2026-11-03
author: openma
tags: ["openai", "agents-api", "agents-sdk", "comparison", "self-hosted", "byok"]
---

"OpenAI agents" now names at least four different things: the
**Agents API**, the **Agents SDK**, **AgentKit**, and its visual
**Agent Builder**. Only the Agents API is a managed runtime. The SDK is
a library, and AgentKit and Agent Builder are authoring tools.

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
is OpenAI's managed runtime and the closest OpenAI equivalent to Claude
Managed Agents. OpenAI runs the Codex-based harness, stores sessions and
progress, and executes code in a hosted sandbox or a self-hosted sandbox
you connect. With a self-hosted sandbox, code runs on your
infrastructure and OpenAI still operates the API control plane.

### Agents SDK

The [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk)
is an open-source library. Agents, tools, handoffs, guardrails, and
tracing run inside your process. It is the OpenAI counterpart to the
[Claude Agent SDK](/blog/claude-agent-sdk-vs-managed-agents/): full
control of the loop, and everything operational (persistence,
sandboxing, recovery, scaling) is yours.

### AgentKit / Agent Builder

AgentKit bundles a visual Agent Builder, the embeddable ChatKit UI,
evaluation tooling, and a connector registry. It is aimed at getting a
workflow designed and in front of users quickly. A visual builder is an
authoring surface. Production agents also need a runtime with tools with real permissions,
credentials, sandboxes, and policies. For the category view of
platforms vs SDKs vs builders, see the
[AI agent platform](/ai-agent-platform/) guide.

## Where durability comes from

Temporal publishes an integration for the OpenAI Agents SDK, which
says something about the SDK's scope: on its own, an
in-process SDK run lives and dies with the process. Temporal adds
durable execution (workflows and activities that survive crashes and
retries) around SDK agents.

A managed runtime provides the same property differently: every input,
output, and tool call is written to a durable session log, and a new
harness resumes from it. The choice between the SDK plus a workflow engine and a managed runtime comes down to whether you want to operate the
durability layer yourself.

## Migration, cost, and data control

### Migration

OpenAI's overview describes the split: OpenAI manages sessions,
orchestration, context compaction, and recovery, while your application
provides tools and chooses the execution environment. Business
permissions and your data stores stay with you. OpenAI also
publishes a cookbook guide for moving from the Claude Agent SDK to the
OpenAI Agents SDK. That guide covers a vendor switch at the SDK layer,
and you still operate the runtime yourself.

### Cost

OpenAI bills Agents API usage at the selected model's API rates, OpenAI
tools at their standard rates, and OpenAI-hosted sandboxes at standard
container rates
([Agents API pricing](https://developers.openai.com/api/docs/guides/agents-api/overview#pricing)).
There is no separate session-hour fee like the one Claude Managed Agents
charges. The SDK adds your own compute and operations. Agents loop,
retry, and call tools, so compare cost per completed task.

### Data control

With the Agents API, OpenAI retains session state. The API currently
supports data residency only in the United States and does not support
Zero Data Retention, and choosing a self-hosted sandbox does not change
that ([Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview)).
With the SDK, sessions live wherever your application stores them.

## Compare to Claude Managed Agents

| | OpenAI Agents API | Claude Managed Agents |
|---|---|---|
| Harness | Codex harness, OpenAI-operated | Anthropic harness, Anthropic-operated |
| Models | OpenAI | Claude |
| Sessions | Hosted, durable | Hosted, durable |
| Sandbox | Hosted or self-hosted sandbox | Cloud sandbox or self-hosted sandbox |
| Control plane | OpenAI | Anthropic |
| Pricing shape | Model tokens, tool usage, and hosted-container rates | Tokens + $0.08 per running session-hour |

Both run their vendor's models and keep the control plane with the
vendor. See
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
| Durable sessions | Yes | Add your own (e.g. a workflow engine) | Yes, event-sourced |
| Sandbox | Hosted or self-hosted | Yours | Replaceable drivers (Docker, E2B, Daytona, Modal, Cloudflare, …) |
| Self-host control plane | No | N/A (library) | Yes |
| Source | Proprietary service | Open source | Apache 2.0 |

OpenMA's OpenAI adapter does not reproduce every behavior of OpenAI's
service, and coverage differs between Node and Cloudflare runtimes. The
[compatibility report](https://github.com/openma-ai/open-managed-agents/blob/main/docs/openai-agents-compatibility-status.md)
lists what is supported, and the
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

For a multi-model, self-hosted managed runtime, see the
[OpenMA docs](https://docs.openma.ai/), read about
[self-hosted AI agents](/self-hosted-ai-agents/), or compare the wider
field in the [Claude Managed Agents alternative](/claude-managed-agents-alternative/)
guide.
