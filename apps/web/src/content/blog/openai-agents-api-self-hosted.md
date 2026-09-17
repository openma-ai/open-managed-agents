---
title: "OpenMA now supports the OpenAI Agents API"
description: "Use the official OpenAI SDK with OpenMA on Node or Cloudflare. Run durable conversations on the hosted service or your own deployment, with runtime-specific support for tools, subagents, and artifacts."
publishedAt: 2026-09-11
updatedAt: 2026-09-17
author: openma
tags: ["release", "openai", "agents-api", "self-hosted", "architecture", "byok"]
---

You can now point the official OpenAI SDK at OpenMA on **Node or Cloudflare**.
The **OpenAI Agents API at `/openai/v1`** uses OpenMA's existing agent
infrastructure for durable sessions. Use the hosted service or run your own
deployment; tool, subagent, and artifact execution support depends on the
selected runtime.

The Claude-compatible API remains available at `/v1` on Node and Cloudflare.
Both contracts use OpenMA's existing session infrastructure. You bring the
model credentials and choose the runtime. Self-hosting also lets you keep
conversation history and outputs on infrastructure you control.

The OpenAI compatibility baseline is `openai@7.15.0`. Cloudflare hosted
sessions were verified on September 16, including continuing the same native
session through the OpenAI and Claude SDKs. The runtime differences are
described below.

## Start with the SDK you already use

Use the [hosted Console](https://app.openma.dev), or start a
[Node + Docker deployment](https://docs.openma.dev/self-host/node-docker/).
Create an OpenMA API key and add a Model Card with your provider credentials.
Then install the pinned SDK in your application:

```bash
npm install openai@7.15.0
```

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENMA_API_KEY,
  baseURL: "https://app.openma.dev/openai/v1", // Hosted on Cloudflare
});

const events = await client.beta.agents.sessions.create({
  agent: {
    model: "your-configured-model",
    instructions: "Be concise and explain your conclusions.",
  },
  environment: { type: "none" },
  input: "Explain when a background task needs durable state.",
  stream: true,
});

for await (const event of events) {
  console.log(event);
}
```

For a local Node deployment, use `http://localhost:8787/openai/v1` as the
base URL instead.

The client API key authenticates to OpenMA. The Model Card provides the
upstream model key. Using the OpenAI API contract does not require every
session to use an OpenAI model: execution uses the model configured in your
OpenMA deployment.

This example selects `environment: { type: "none" }`, so the conversation
runs without provisioning a physical sandbox on either runtime. Node also
supports client function-tool continuation on this path. Code execution and
environment files require a connected sandbox and support in the selected
runtime. The [SDK guide](https://github.com/openma-ai/open-managed-agents/blob/main/packages/openai-agents-compat/README.md)
describes the request contract and runtime boundaries.

## A session can outlive your connection

On Node, consider an agent that needs your application to look up an order. It emits
a function call, pauses, and waits for a result. Your service might restart
before that lookup finishes. A useful agent platform needs to retain exactly
which call is pending and where its result belongs.

OpenMA persists the pending action in the session's native history. After a
Node restart with storage retained, your application can retrieve the session,
submit the result with the original call and turn identifiers, and continue
the same unfinished turn. An accepted input retried with the same idempotency
key and payload is not dispatched again. Reusing that key for different input
returns a conflict.

That gives an application a durable place to reconnect to. Your own external
function side effects still need idempotency, just as they would in any
background job system.

Streaming follows the same separation between execution and observation.
Disconnecting from SSE stops listening; it does not cancel the agent. To stop
execution, send an explicit cancellation event. If you reconnect after missing
output, read the durable **Items and Turns** and subscribe to new events.
The pinned OpenAI stream is live-only, so clients should not expect it to
replay everything they missed.

## Delegate work and keep the child conversations

On Node, enable `agent.multi_agent.enabled` and the main agent can delegate
subtasks. Hosted Cloudflare sessions do not yet support these OpenAI dynamic
subagent controls.
It receives controls to create a child, send input, wait, interrupt, close,
and resume it. Each child keeps its own conversation history and shares the
parent's files when a sandbox is connected.

For example, a coordinator can ask one child to investigate an implementation
and another to examine its tests. When they finish, it can ask a follow-up in
the same child conversation instead of starting from scratch. The API exposes
child Items and Turns so an application can show those histories separately.

The current execution baseline is **single-level delegation**. The main agent
can create children; children do not receive tools to create further children.
They inherit MCP and search configuration, while client function tools remain
on the main agent. A completed child turn leaves that child available for
further work; closing it is a separate lifecycle action.

## Keep the files that matter

On Node, when an agent runs in a connected environment, file operations reach
the real sandbox. Outputs written under **`/workspace/outputs`** are published as
immutable Artifacts after the corresponding root turn completes successfully.
You can list, retrieve, download, and delete those artifacts through the SDK.

An artifact records the session, environment, turn, and path it came from.
This lets an application associate a generated report or patch with the work
that produced it, even after the sandbox has gone away. Ordinary uploaded
files do not automatically become artifacts, and publication happens after
execution completion as its own persistence step.

The environment type name `openai_hosted` belongs to the API contract. With
OpenMA, the environment is still supplied by your configured runtime; it is
not a request to execute on OpenAI's hosted service.

## Two APIs, one durable history

The implementation translates the OpenAI contract onto OpenMA's existing
application services. Saved agents use native agent records. Credentials use
the existing encrypted vault services. Artifacts use native immutable files.
Sessions, Turns, Items, and required actions are reconstructed from ordered,
committed session facts.

This matters when something goes wrong. There is one authoritative history
behind execution and the API views, so a process restart does not require
reconciling a second set of OpenAI-specific conversation tables. Child
histories use native session threads, and initial input is admitted through
the durable execution outbox.

These changes sit alongside the recent work on execution leases, managed
resource preparation, sandboxed ACP harnesses, and persistent memory. They
extend the platform's shared execution machinery. The OpenAI adapter does
not yet expose every capability available through the native API.

## What this release covers

The September 16 hosted verification used a real model to create, retrieve,
and list Agents, start a no-environment session, receive a first reply, and
continue the conversation through the OpenAI SDK. It also verified continuing
that same native session through the Claude SDK, authentication failures,
cross-tenant isolation, and execution on a non-default D1 shard. Node and
Cloudflare share the sandbox selection and preparation lifecycle.

The release has maintained tests using the official SDK against the production
Node service, real SQL persistence, and a controlled local model server. They
exercise resource persistence, function continuation, child controls, restart
recovery, streaming, and cancellation. Separate contract tests cover SDK
requests, HTTP responses, and history projection.

That evidence has a specific scope. It does not certify every live model or
physical sandbox provider, and broad HTTP coverage does not mean every saved
configuration can execute today.

The current limits are:

- **Runtime coverage differs.** Both Node and Cloudflare expose the OpenAI
  endpoint. Hosted dynamic subagent controls are not yet supported. The
  function-continuation and artifact workflows described above are backed by
  Node runtime tests; the hosted verification does not establish full parity.
- **Advanced environment configuration is incomplete.** Packages, setup,
  environment variables, input-file injection, plugins, skills, capability
  directories, and restricted networking are not wired through this adapter.
- **Some model and tool options are incomplete.** Explicit reasoning controls,
  fast service tier, structured output, deferred tools, and advanced MCP
  configuration are not yet supported on this execution path.
- **Delegation is one level deep.** Recursive child execution is outside this
  release's baseline.

Unsupported execution settings are rejected when creating a session. Saving
an agent or environment template does not imply that the selected runtime
can enact every option. The
[compatibility report](https://github.com/openma-ai/open-managed-agents/blob/main/docs/openai-agents-compatibility-status.md)
has the detailed list.

## Try it hosted or on your own server

Use the [hosted Console](https://app.openma.dev) and the SDK example above,
or follow the [Node deployment guide](https://docs.openma.dev/self-host/node-docker/)
for a self-hosted installation. The
[OpenAI Agents API guide](https://github.com/openma-ai/open-managed-agents/blob/main/packages/openai-agents-compat/README.md)
covers the client setup.
The [source and test suites](https://github.com/openma-ai/open-managed-agents)
are available under Apache 2.0.

If you already use OpenMA's Claude-compatible API, your existing endpoint
remains available. For an application built around the OpenAI Agents contract,
there is now another way to run it: with OpenMA managing durable execution
on the hosted service or on infrastructure you control.

For the product thinking behind this work, read
[Why Agent as a Service](/blog/why-agent-as-a-service/): what changes when a team
can hand an agent an ongoing assignment.
