---
title: "Claude Agent SDK vs Managed Agents: When to Migrate | OpenMA"
description: "The Claude Agent SDK runs the harness in your process; Managed Agents hosts it. Compare state, sandboxes, recovery, and when to migrate to a managed runtime."
publishedAt: 2026-11-03
author: openma
tags: ["claude", "agent-sdk", "managed-agents", "comparison", "migration"]
---

The **Claude Agent SDK** and **Claude Managed Agents** both give Claude
an agent loop with tools. The SDK runs that loop inside your own
process. Managed Agents runs it for you on Anthropic's infrastructure.
That difference decides who owns state, sandboxing, recovery, and
scaling.

For a primer on the hosted product, read
[what is Claude Managed Agents](/what-is-claude-managed-agents/).

## Scope of the Claude Agent SDK

### What the SDK includes

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` for TypeScript,
`claude-agent-sdk` for Python) packages the harness behind Claude Code
as a library. You get:

- **The agent loop:** context building, model calls, tool dispatch,
  compaction.
- **Built-in tools** for files, shell, and search, plus custom tools and
  MCP servers.
- **Skills, subagents, hooks, and permission modes** to shape behavior.

What you do not get is anything outside your process. The harness and
its tools run wherever you run the SDK: a laptop, a container, a CI
job. If you want isolation, you put the whole process inside a sandbox.
OpenAI's cookbook guide on migrating from the Claude Agent SDK describes
exactly this pattern: the sandbox *contains* the harness.

That is ideal for a single agent embedded in an application or a
developer workflow. It becomes work once you need many concurrent
sessions, resumable state, or multi-tenant isolation.

## Claude Agent SDK vs Claude Managed Agents



| | Claude Agent SDK | Claude Managed Agents |
|---|---|---|
| Where the harness runs | Your process | Anthropic's infrastructure |
| Session state | In memory / your persistence | Hosted, durable, resumable |
| Sandbox | Your process or the container you put it in | Anthropic cloud sandbox or self-hosted sandbox |
| Crash recovery | Yours to build | Built in |
| Concurrency and scaling | Yours to build | Built in |
| Event stream for UIs | Yours to expose | SSE event stream |
| Billing | Tokens + your compute | Tokens + $0.08 per running session-hour |
| Models | Claude | Claude |
| Control of the loop | Full (it's a library) | None (hosted harness) |

Both run Claude only. The SDK has no platform fee and leaves operations
to you. Managed Agents runs the operations for a session-hour fee. For
the cost side, see
[Claude Managed Agents pricing](/blog/claude-managed-agents-pricing/).

## Where teams move from the SDK

### Toward OpenAI Agents SDK (cookbook pattern)

OpenAI publishes a cookbook guide for moving from the Claude Agent SDK
to the OpenAI Agents SDK. Its main architectural point is moving the
harness *outside* the sandbox and treating the sandbox as a tool,
mapping `CLAUDE.md` to `AGENTS.md`, and translating skills, guardrails,
approvals, and handoffs. It is a vendor switch: you trade Claude-only
for OpenAI-first, and you still operate the runtime yourself. See the
[OpenAI Agents SDK / API](/blog/openai-agents-api-vs-openma/) comparison
for how the OpenAI pieces fit together.

### Toward a managed multi-model runtime

The other path keeps the managed-runtime benefits of Claude Managed
Agents but drops the single-vendor constraint. A multi-model managed
runtime handles sessions, sandboxes, recovery, and credentials, and
treats the model and harness as configuration.

## A managed runtime you can self-host with any model

In the comparison table, both columns list **Claude** as the only model.
The SDK leaves every operational row to you, and Managed Agents runs
them on Anthropic's cloud. A third option combines the following:

| | Needed |
|---|---|
| Harness | Managed for you, but readable and replaceable |
| Sessions, recovery, event stream | Built in |
| Sandbox | Your choice of provider |
| Models | Any provider, chosen per agent |
| Deployment | Your infrastructure, or hosted |

[OpenMA](/claude-managed-agents-alternative/) is an open-source runtime
with these properties. It keeps the Claude Managed Agents API shape
(agents, environments, sessions, events) and runs agents on Claude,
OpenAI, DeepSeek, OpenRouter, or a custom endpoint. You can use its
built-in harness, write your own, or bring Claude Code or Codex into a
managed sandbox through ACP adapters.

## Where the SDK sits

In the brain-and-hands split Anthropic describes for Managed Agents (see
[what is Claude Managed Agents](/what-is-claude-managed-agents/)), the
Claude Agent SDK is the brain side: a harness for Claude. Scheduling
sessions, durable state, and sandbox management come from the runtime
around it. For the category view, see
[AI agent platform & orchestration](/ai-agent-platform/).

## Moving from the SDK to a managed runtime

Moving off the in-process SDK to a managed runtime, Anthropic's or an
open one, goes smoother with this list:

1. **Inventory tools.** Separate built-in file/shell tools (provided by
   the runtime) from custom tools and MCP servers you need to register.
2. **Move instructions.** Your system prompt, `CLAUDE.md`-style project
   notes, and skills become agent configuration and mounted skills.
3. **Define the environment.** Packages, networking rules, and the
   sandbox your tools need.
4. **Move secrets out of the process.** Put API tokens in a vault so the
   runtime injects them into outbound requests and the sandbox never holds them.
5. **Replace your loop with sessions.** Create a session per task or
   conversation, send `user.message` events, and stream events back.
6. **Map approvals.** Permission prompts become tool permission
   policies and `user.tool_confirmation` events.
7. **Handle custom tools.** Client-executed tools pause the session
   with `requires_action`. Reply with `user.custom_tool_result`.
8. **Decide on models.** If you are moving to an open runtime, decide
   which agents stay on Claude and which move to other providers.
9. **Measure cost per completed task** before and after.

OpenMA-specific steps are in the [OpenMA docs](https://docs.openma.ai/),
and teams coming from the hosted product can follow
[migrating from Claude Managed Agents](/blog/migrate-from-claude-managed-agents/).

## When to stay on the SDK only

Stay on the Claude Agent SDK when:

- You run one agent, or a few, inside an application you already operate.
- Sessions are short and losing one on a crash is acceptable.
- Claude is your only model and you want full control of the loop.
- You do not need a multi-tenant API or an operator console.

Move to a managed runtime when you need durable sessions, isolated
sandboxes per task, many concurrent users, or credentials kept out of
the agent's reach. If you also need more than one model vendor or your
own infrastructure, compare the
[Claude Managed Agents alternative](/claude-managed-agents-alternative/)
options.
