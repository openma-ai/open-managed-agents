---
title: "Claude Managed Agents Pricing (2026): Session Runtime + Tokens"
description: "Break down CMA session-hour and token costs, hidden spend, and cheaper self-host / multi-model paths."
publishedAt: 2026-11-03
author: openma
tags: ["pricing", "claude", "managed-agents", "comparison", "self-hosted"]
---

Claude Managed Agents (CMA) pricing has two moving parts: the **tokens**
your agent consumes and the **session runtime** it spends in a running
state. This guide explains both, separates CMA from the Claude Code plan
pricing that crowds the same search results, lists the costs teams tend
to miss, and walks through a monthly estimate you can redo with your own
numbers.

Figures below come from Anthropic's public
[pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing#claude-managed-agents-pricing)
as of November 2026. Rates change — check that page before you budget.
If you need a refresher on what the product is, start with
[what is Claude Managed Agents](/what-is-claude-managed-agents/).

## What's billable (official components)

### Tokens

Every model call your agent makes is billed at the standard Claude API
token rates for the model the agent uses — input, output, and prompt
caching reads and writes, as listed on the pricing page. Managed Agents
does not add a separate per-token markup; the harness simply makes more
calls than a single chat request would, because an agent loops: read
context, call the model, run a tool, feed the result back, repeat.

### Session runtime

On top of tokens, Anthropic charges **$0.08 per session-hour** for
session runtime. Runtime is metered while a session is in the
**running** status — when the harness is actively working. A session
sitting idle, waiting for your next message, is not accruing runtime.

That makes the runtime fee easy to reason about:

| Running time per session | Runtime cost per session |
|---|---|
| 6 minutes | $0.008 |
| 30 minutes | $0.04 |
| 1 hour | $0.08 |
| 8 hours | $0.64 |
| Running 24/7 for a month (~730 h) | ~$58.40 |

## Not the same as Claude Code pricing

### SERP conflation with Cowork and Code plans

Search for "Claude Managed Agents pricing" and most results are about
Claude Code and the Pro, Max, Team, or Enterprise subscription plans.
Those are seat-based plans for people using Claude's apps and Claude
Code. Claude Managed Agents is a developer platform API: it is billed by
usage — tokens plus session runtime — through your Claude Platform
account, separately from subscription seats.

If your team uses both, budget them separately.

## Hidden and easy-to-miss spend

### Tools and external calls

Server-side tools carry their own published charges — web search is
the common example — and every tool result you feed back into context
becomes input tokens on the next turn. A tool that returns a 40 KB page
is not free even if the tool call itself is.

MCP servers and external APIs your agent calls are billed by whoever
runs them. They do not appear on your Anthropic invoice, but they are
part of the cost of a run.

### Retries and failed runs

A run that fails at step 18 of 20 has already paid for 18 steps of
tokens and runtime. Tool errors that the agent retries, sessions you
re-run after a bad outcome, and outcome-evaluation loops that iterate
until a rubric is satisfied all multiply the base cost. Track cost per
*completed* task, not per session.

### Idle vs running session status

Runtime only accrues while running, which rewards agents that finish
and go idle. It penalizes agents that poll, wait on slow tools while
still "running," or run long background jobs inside a session. Context
growth is the other slow leak: long sessions re-send more history on
every model call unless you manage compaction and caching well.

## Worked monthly example

### Assumptions table (sessions × hours × tokens)

A support-triage agent, modeled for one month. Replace these with your
own measurements — the structure matters more than the inputs.

| Input | Value |
|---|---|
| Sessions per month | 2,000 |
| Average running time per session | 12 minutes (0.2 h) |
| Average input tokens per session (all turns, after caching) | 150,000 |
| Average output tokens per session | 10,000 |
| Model input / output rate | `P_in` / `P_out` USD per million tokens, from the pricing page |

**Session runtime**

2,000 sessions × 0.2 h = 400 session-hours × $0.08 = **$32.00**

**Tokens**

- Input: 2,000 × 150,000 = 300M tokens → 300 × `P_in`
- Output: 2,000 × 10,000 = 20M tokens → 20 × `P_out`

**Monthly total** = $32 + 300 × `P_in` + 20 × `P_out` (+ tool charges)

Two things fall out of the formula:

1. For short, chatty sessions, **tokens dominate**. The runtime fee
   here is $0.016 per session, while 160,000 tokens per session at any
   current Claude rate costs far more. Prompt caching and context
   hygiene are your biggest levers.
2. For **long-running or always-on agents**, runtime becomes a real
   line item. Ten agents running around the clock are ~$584/month in
   runtime alone, before tokens.

## Cost shape vs self-host / OpenMA

### What changes, and what doesn't

An open, self-hosted runtime does not make model tokens cheaper — if you
run Claude on [OpenMA](/blog/claude-managed-agents-vs-open-managed-agents/),
you pay Anthropic's token rates directly with your own key. What changes
is the shape of everything else:

| Cost line | Claude Managed Agents | OpenMA self-hosted | OpenMA hosted |
|---|---|---|---|
| Model tokens | Anthropic rates, Claude only | Your provider's rates (BYOK), any supported model | Your provider's rates (BYOK) |
| Runtime | $0.08 per running session-hour | Your servers, database, and sandbox provider | Wallet-based cloud sandbox compute; see [pricing](/pricing/) |
| Platform fee | Included in runtime | None (Apache 2.0) | Included in sandbox compute |
| Operations | Anthropic | Your team | OpenMA |

Where self-hosting tends to help: moving cheaper workloads to other
models through the same runtime, reusing infrastructure you already
pay for, and keeping long-running sessions on compute you have priced
yourself. Where it does not: if your team would spend more on operating
the platform than the runtime fee costs, CMA is the cheaper option.

For the broader view of options, see
[Claude Managed Agents alternatives](/claude-managed-agents-alternative/)
and the shortlist of
[open-source managed agents](/open-source-managed-agents/).

## FAQ

**Are Claude Managed Agents free?**
No. There is no separate free tier for the runtime; you pay token usage
plus $0.08 per running session-hour, billed through the Claude Platform.

**How much does a Claude managed agent cost per hour?**
$0.08 per session-hour of running time, plus the tokens it consumes in
that hour. The token portion is usually larger.

**Is idle time billed?**
Session runtime is metered while the session is running. Idle sessions
waiting for input do not accrue runtime.

**Is there a Claude Managed Agents pricing calculator?**
Use the worked example above: sessions × running hours × $0.08, plus
input and output tokens × your model's rates.

**Is self-hosting cheaper?**
Sometimes. It removes the runtime fee and lets you mix models, but adds
infrastructure and operations cost. Model both before deciding — start
with the [Claude Managed Agents vs OpenMA](/blog/claude-managed-agents-vs-open-managed-agents/)
comparison, then the [OpenMA docs](https://docs.openma.ai/) once you
have picked a hosting path.
