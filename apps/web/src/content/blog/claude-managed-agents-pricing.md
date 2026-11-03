---
title: "Claude Managed Agents Pricing: Runtime + Tokens | OpenMA"
description: "Claude Managed Agents pricing explained: $0.08 per running session-hour plus Claude token costs, with a worked monthly example and the cost-saving paths."
publishedAt: 2026-11-03
author: openma
tags: ["pricing", "claude", "managed-agents", "comparison", "self-hosted"]
faq:
  - question: "Are Claude Managed Agents free?"
    answer: "No. New API accounts get a small amount of free credit for testing. After that, Managed Agents usage is billed as tokens plus $0.08 per running session-hour through the Claude Platform."
  - question: "How much does a Claude managed agent cost per hour?"
    answer: "$0.08 per session-hour of running time, plus the tokens it consumes in that hour. The token portion is usually larger."
  - question: "Is idle time billed?"
    answer: "Session runtime is metered while the session is running. Idle sessions waiting for input do not accrue runtime."
  - question: "Is there a Claude Managed Agents pricing calculator?"
    answer: "Use the worked example above: sessions × running hours × $0.08, plus input and output tokens × your model's rates."
  - question: "Is self-hosting cheaper?"
    answer: "Sometimes. It removes the runtime fee and lets you mix models, but adds infrastructure and operations cost. Model both before deciding. Start with the [Claude Managed Agents vs OpenMA](/blog/claude-managed-agents-vs-open-managed-agents/) comparison, then the [OpenMA docs](https://docs.openma.ai/) once you have picked a hosting path."
---

Claude Managed Agents (CMA) pricing has two moving parts: the **tokens**
your agent consumes and the **session runtime** it spends in a running
state. Both are usage-based and billed separately from Claude Code
subscription plans.

Figures below come from Anthropic's public
[pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing#claude-managed-agents-pricing)
as of November 2026. Rates change, so check that page before you budget.
If you need a refresher on what the product is, start with
[what is Claude Managed Agents](/what-is-claude-managed-agents/).

## What Anthropic bills

### Tokens

Every model call your agent makes is billed at the standard Claude API
token rates for the model the agent uses: input, output, and prompt
caching reads and writes, as listed on the pricing page. Managed Agents
does not add a separate per-token markup. The harness makes more
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



The Pro, Max, Team, and Enterprise subscription plans are seat-based plans for people using Claude's apps and Claude
Code. Claude Managed Agents is a developer platform API: it is billed by
usage (tokens plus session runtime) through your Claude Platform
account, separately from subscription seats.

If your team uses both, budget them separately.

## Hidden and easy-to-miss spend

### Tools and external calls

Server-side tools carry their own charges. Web search inside a session
costs $10 per 1,000 searches, and every tool result you feed back into context
becomes input tokens on the next turn. When a tool returns a 40 KB page,
that page is billed as input tokens even if the tool call itself is free.

MCP servers and external APIs your agent calls are billed by whoever
runs them. They do not appear on your Anthropic invoice, but they are
part of the cost of a run.

### Pricing modifiers

The pricing page lists a few modifiers that change the token line:

- Setting an agent's `model.speed` to `"fast"` bills fast-mode premium rates.
- Pinning `model.inference_geo` to `"us"` bills tokens at 1.1x.
- The Batch API's 50% discount does not apply, because sessions are
  stateful and interactive.

Session runtime replaces the code execution container-hour billing, so
you are not charged container hours on top of it.

### Retries and failed runs

A run that fails at step 18 of 20 has already paid for 18 steps of
tokens and runtime. Tool errors that the agent retries, sessions you
re-run after a bad outcome, and outcome-evaluation loops that iterate
until a rubric is satisfied all multiply the base cost. Track cost per *completed* task.

### Idle vs running session status

Runtime only accrues while running, which rewards agents that finish
and go idle. It penalizes agents that poll, wait on slow tools while
still "running," or run long background jobs inside a session. Context
growth is the other slow leak: long sessions re-send more history on
every model call unless you manage compaction and caching well.

## Worked monthly example



A support-triage agent, modeled for one month. Replace these with your
own measurements, and the same formula applies.

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

1. On mid-size and large models, **tokens dominate**. The runtime fee
   here is $0.016 per session. On Claude Sonnet 5 ($2 input / $10 output
   per million tokens) the same session's tokens cost about $0.40. On
   Claude Haiku 5.5 ($0.10 / $0.50 for prompts up to 100k tokens) they
   cost about $0.02, so with a small model the runtime fee is about as
   large as the token bill. Prompt caching and context size are the
   biggest levers on larger models.
2. For **long-running or always-on agents**, runtime becomes a real
   line item. Ten agents running around the clock are ~$584/month in
   session runtime only, excluding model token costs.

## How the bill changes if you self-host

An open, self-hosted runtime does not make model tokens cheaper. If you
run Claude on [OpenMA](/blog/claude-managed-agents-vs-open-managed-agents/),
you pay Anthropic's token rates directly with your own key. What changes
is the shape of everything else:

| Cost line | Claude Managed Agents | OpenMA self-hosted | OpenMA hosted |
|---|---|---|---|
| Model tokens | Anthropic rates, Claude only | Your provider's rates (BYOK), any supported model | Your provider's rates (BYOK) |
| Runtime | $0.08 per running session-hour | Your servers, database, and sandbox provider | Wallet-based cloud sandbox compute; see [pricing](/pricing/) |
| Platform fee | Included in session runtime | None | None. You pay for sandbox compute ([pricing](/pricing/)) |
| Operations | Anthropic | Your team | OpenMA |

Self-hosting tends to save money when you move cheaper workloads to
other models through the same runtime, reuse infrastructure you already
pay for, or keep long-running sessions on compute you have priced
yourself. If your team would spend more on operating the platform than
the runtime fee costs, CMA is the cheaper option.

For the broader view of options, see
[Claude Managed Agents alternatives](/claude-managed-agents-alternative/)
and the shortlist of
[open-source managed agents](/open-source-managed-agents/).

