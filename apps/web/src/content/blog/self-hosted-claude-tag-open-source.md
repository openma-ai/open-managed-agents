---
title: "How to Self-Host a Claude Tag-Style Agent"
description: "Claude Tag is hosted. This guide maps the same product shape onto an open-source, self-hosted Open Managed Agents deployment."
publishedAt: 2026-06-25
author: openma
tags: ["claude-tag", "self-hosted", "open-source", "guide", "integrations"]
---

Claude Tag makes a simple promise: tag an AI teammate in Slack, give it
work, and let it use approved tools and context to finish the task. That
is a strong product shape because it meets teams where they already
coordinate work.

But there is another version of the same pattern: run the agent platform
yourself, publish your own Slack bot identity, connect only the tools you
approve, and keep the event log, memory, credentials, and sandbox under
your control.

This guide shows how to think about a self-hosted Claude Tag-style agent
with Open Managed Agents.

## The product shape

The user experience should feel familiar:

1. Someone mentions the agent in a Slack channel.
2. The agent reads the thread and relevant channel context.
3. It plans the work and uses approved tools.
4. It posts progress or a final answer back in the same thread.
5. The channel keeps a durable session so follow-up work has context.

That is not just a chatbot. It needs a runtime with five pieces:

| Layer | Job |
|---|---|
| Slack publication | Gives the agent a workspace identity and webhook entry point |
| Session runtime | Turns channel events into durable agent sessions |
| Tool layer | Exposes Slack, GitHub, Linear, web, shell, MCP, and private APIs |
| Vault | Stores model keys and integration tokens encrypted at rest |
| Sandbox | Runs code, file operations, tests, and long-running work safely |

Open Managed Agents ships those pieces as an open-source platform rather
than a single Slack-only product.

## Architecture

For a Slack-first deployment, the core flow looks like this:

```text
Slack channel
  -> Slack Events API
  -> openma integrations gateway
  -> session dispatch
  -> agent harness
  -> model + tools + sandbox
  -> Slack thread reply
```

The important detail is that the Slack app is not global. Open Managed
Agents uses per-publication Slack Apps, so each published agent can have
its own client id, signing secret, scopes, bot identity, and audit trail.

That makes a few useful patterns possible:

- One engineering agent in `#eng-build`.
- One support agent in `#support-triage`.
- One data agent in `#growth-metrics`.
- One private incident agent with narrower membership and stronger tool
  access.

Each publication can be scoped differently instead of forcing one giant
workspace bot to carry every permission.

## Step 1: Run Open Managed Agents

For local evaluation:

```bash
git clone https://github.com/openma-ai/open-managed-agents.git
cd open-managed-agents
cp .env.example .env

# Required:
# BETTER_AUTH_SECRET signs Console sessions.
# PLATFORM_ROOT_SECRET encrypts model keys and integration tokens.

docker compose up -d
open http://localhost:8787
```

For a production self-host, deploy the API, Console, integrations
gateway, and agent runtime on Cloudflare Workers or the Node/Docker
backend. The Cloudflare route gives you Workers, Durable Objects,
Containers, D1, KV, and R2. The Docker route gives you a simpler
self-host path with SQLite or Postgres.

See the [self-host overview](https://docs.openma.dev/self-host/overview/)
for the full deployment choices.

## Step 2: Create the agent

In the Console, create an agent with:

- A model card, such as Claude Sonnet or another OpenAI-compatible model.
- A system prompt that defines the teammate role.
- Built-in tools for files, shell, web, and session work.
- Optional MCP servers for services like GitHub, Linear, Notion, or
  internal tools.
- Optional skills for repeated workflows, such as PR review, incident
  triage, analytics summaries, or support escalation.

The key difference from a hosted-only product is that the model key is
your key. Open Managed Agents is BYOK: you can route model calls to
Anthropic, OpenAI, OpenRouter, or a compatible gateway.

## Step 3: Publish it into Slack

The Slack publication flow creates a dedicated Slack App for the agent.
In a self-host deployment, you need a public HTTPS URL for the
integrations gateway because Slack verifies OAuth redirect URLs and
Events API request URLs.

In development, use a tunnel. In production, use your normal HTTPS host.

The flow is:

1. Start the Slack publication wizard from the Console or CLI.
2. Open the generated Slack manifest URL.
3. Create the Slack App from the pre-filled manifest.
4. Copy the Client ID, Client Secret, and Signing Secret back into
   Open Managed Agents.
5. Install the app into the workspace.
6. Invite the bot to the channels it should serve.

The agent can now respond to `app_mention`, DMs, and thread replies.
Top-level channel messages can also be scanned according to the
integration's dispatch rules.

## Step 4: Add tools carefully

The Claude Tag lesson is that an AI teammate gets useful when it can do
work, not just talk about work. The security lesson is that every tool
should be scoped.

Start with a small set:

| Tool | Good first use |
|---|---|
| Slack | Reply in threads, search channel history, create summaries |
| GitHub | Read issues and PRs, comment, review, prepare changes |
| Linear | Triage issues, update status, add comments |
| Web | Fetch docs and public references |
| Shell | Run tests or scripts inside the sandbox |
| Files | Create artifacts in the session workspace |

Then add MCP servers or custom integration providers for internal
systems. Open Managed Agents exposes a provider interface for new
integrations, so Jira, Discord, internal CRMs, billing systems, and data
tools can all follow the same install, webhook, tool, and publication
shape.

## Step 5: Decide what the agent remembers

Claude Tag's channel memory is part of what makes it feel like a
teammate. A self-hosted version should be explicit about memory.

Good defaults:

- Keep the per-channel session event log.
- Store durable team facts in a memory store only after the agent has a
  reason to remember them.
- Keep private incident, finance, legal, and customer channels separate.
- Make memory review and deletion an operator workflow.
- Keep credentials in vaults, not in prompts or channel text.

Open Managed Agents separates event history, memory stores, vaults, and
workspace files so you can tune retention and access independently.

## Step 6: Add operational guardrails

A Claude Tag-style agent should not be a mystery process with write access.

Before broad rollout, set:

- Model budgets per agent or tenant.
- Tool scopes per publication.
- Webhook signature verification.
- Sandbox timeouts and resource limits.
- Logging for integration dispatches and tool calls.
- A small pilot channel before workspace-wide installation.

This is where self-hosting has a real advantage: the operational model
can match the rest of your infrastructure instead of living entirely
inside a vendor console.

## Claude Tag-style, not Claude Tag-cloned

There are things Claude Tag will do better out of the box. It is built
by Anthropic, tightly connected to Claude, and designed as a polished
Slack-native beta for Claude Team and Enterprise customers.

A self-hosted Open Managed Agents setup wins on a different axis:

- You can run it yourself.
- You can change the harness.
- You can use different model providers.
- You can add private integrations.
- You can own the data plane.
- You can publish agents into Slack, GitHub, and Linear from one
  runtime.

For teams that see Claude Tag-style agents as product infrastructure,
that is often the more important trade.

## Next steps

Start with Docker if you want a local proof of concept. Move to
Cloudflare or Postgres once you know the agent shape is useful. Then
publish a narrow Tag-style agent into one channel, give it one or two
real tools, and observe where humans naturally delegate work.

For more detail, read the
[Slack self-host setup](https://docs.openma.dev/self-host/oauth-apps/#slack),
the [custom integrations guide](https://docs.openma.dev/build/integrations/),
and the [Cloudflare deployment guide](/blog/self-host-agent-platform-cloudflare-workers/).
