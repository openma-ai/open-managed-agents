---
name: openma
description: >
  Use an existing OpenMA instance to build and manage AI agents. Trigger when
  users want to create agents, start sessions, manage environments, configure
  model cards, handle vaults/credentials, install skills, connect MCP servers,
  or interact with the openma HTTP API. Also trigger when users mention "oma",
  "openma", "managed agents", or ask how to run/manage an agent on OpenMA. For deploying the platform
  itself, use the deploy-openma skill instead.
---

# openma

openma is an open-source platform for building, deploying, and managing AI agents.
You define an agent (model + system prompt + tools), the platform handles sandboxed
execution, credential management, and session state.

## Setup

```bash
npm install -g @openma/cli
oma auth login --base-url https://app.openma.ai
```

For self-hosted instances, replace the login URL with the user's server origin.
Confirm the instance and workspace before creating resources. Let the user complete
browser authentication. For automation, accept `OMA_BASE_URL` and `OMA_API_KEY`
from an existing secret manager or protected environment; do not ask for secrets
in chat or print them in logs.

Run `oma --help` and `oma api` to check the installed CLI's commands and API shape.
The CLI connects to an existing server; installing it does not deploy OpenMA.

## Core Workflow

```bash
oma models list
oma envs list
oma agents list
```

Use an existing Model Card's `model_id`, not its database record ID. Choose a
ready environment with the needed runtime capabilities. Create missing resources
only as required for the user's task; replace the placeholders below with the
returned IDs:

```bash
oma agents create "my-agent" --model <model-id> --system "Help with the requested task."
oma sessions create --agent <agent-id> --env <environment-id>
oma sessions chat <session-id> "Your task here"
```

`chat` sends a turn and streams its reply. `message` sends without waiting;
`tail` follows events. A delivered message is not proof that the task succeeded.
Check the resulting session status, events and outputs.

## Resources

| Resource | CLI commands | Purpose |
|----------|-------------|---------|
| Agent | `oma agents create/list/get/delete` | Model + prompt + tools config |
| Environment | `oma envs create/list` | Sandbox runtime for sessions |
| Session | `oma sessions create/list/message` | Conversation with an agent |
| Model Card | `oma models create/list` | LLM API key + provider config |
| Vault | `oma vaults create/list` | Secure credential storage |
| Credential | `oma creds list`, `oma secret add` | Secret inside a vault |
| Skill | `oma skills list/install` | Domain expertise for agents |
| API Key | `oma keys create/list/revoke` | Auth token for CLI/SDK |
| Linear | `oma linear list/pubs/publish/submit/handoff/update/unpublish/get` | Publish agent into a Linear workspace |

## Model Cards

Prefer Console Model Cards for entering provider credentials. `oma models list`
shows configured card handles; use `oma api models` for the current API contract.
Providers use Pi IDs such as `anthropic`, `openai`, `deepseek`, and `openrouter`;
legacy aliases remain accepted. Custom providers can require `base_url` and
`pi_config.api`; use the [SDK guide](https://github.com/openma-ai/open-managed-agents/tree/main/packages/sdk#pi-backed-model-cards)
for that shape rather than assuming the CLI exposes every field.

## MCP Server Connections

```bash
oma vaults create "my-vault"
oma connect github --vault <vault-id>
```

Known servers: `airtable`, `amplitude`, `apollo`, `asana`, `atlassian`, `clickup`,
`github`, `intercom`, `linear`, `notion`, `sentry`, `slack`.

## HTTP API Reference

Run `oma api` for the full endpoint reference, or `oma api <resource>` for a specific
resource (agents, sessions, environments, models, vaults, oauth, skills, files,
memory, keys, evals, clawhub).

All `/v1/*` endpoints require `x-api-key` header. Use SSE streaming via
`GET /v1/sessions/:id/events/stream` for real-time agent responses.

## Tips

- Check `oma agents list` / `oma envs list` before creating — reuse existing resources.
- Sessions are stateful — send multiple messages to continue the conversation.
- Use `oma api sessions` to see the full HTTP API when you need to code against it.
- The `agent_toolset_20260401` tool type gives agents file ops, bash, and web access.

## Integrations

Publish an agent into a third-party tool so it acts as a teammate there.
See [`integrations-linear.md`](integrations-linear.md) for the Linear flow —
covers the OAuth-app handshake, the two moments a human is genuinely needed,
and how to verify / unpublish from the CLI.
