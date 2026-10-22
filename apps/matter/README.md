# @open-managed-agents/matter

The OpenMatter host for OpenMA, as its own process. It runs OpenMatter
(Bond, Loops, provider connections such as Feishu) next to an OpenMA
deployment and drives OpenMA Agents only through the public OpenMA API. Nothing
in `apps/main`, `apps/main-node` or `packages/control-plane-node` depends on it.

This package currently contains the Agent side:

- `createOmaClient`: a small client for the public sessions API (create, find
  by title, archive, send events, stream events with `Last-Event-ID` replay).
- `createOpenMAConnector`: an `OpenMAAgentConnector` for
  `makeConnectorAgentDriver` from `@openma/matter/agent`. One OpenMatter Agent
  Session is one OpenMA session, created idempotently (the title carries the
  idempotency key). One Turn is one `user.message` and ends at the next
  terminal status.
- `OperationCallBridge`: correlates the Agent's calls to the Matter MCP server
  with OpenMatter operation calls.
- `createMatterMcpHandler`: the Matter MCP server as a fetch-style handler
  (streamable HTTP, JSON responses). It lists the tools of the caller's latest
  Turn and forwards each call through the bridge. It holds no provider
  credentials.
- `createMemorySessionTokenStore` and `sessionVaults`: one random bearer per
  OpenMatter Agent Session (only its hash is kept), placed in a vault of its own
  as a `static_bearer` credential for the MCP server URL. OpenMA attaches it to
  the session's MCP requests, so the MCP server learns the Session from the
  bearer and never from request arguments.
- `FeishuConnectService` and `createFeishuConnectHandler`: the "Connect
  Feishu" page. It starts a one-click app registration with the
  `feishu-agent` preset (scopes and events), shows the link as a QR code,
  polls in the background, hands the new app's credentials to the host
  (`onRegistered`) and then shows the app's setup check. The device code and
  the app secret never reach the browser. Each registration belongs to the
  tenant that started it and may carry the OpenMA Agent chosen to answer; the
  host's `onRegistered` receives both with the app.
- `trustedProxyPrincipal`: the `authorize` for the usual deployment, where the
  Console reaches Matter through the OpenMA control plane. The control plane
  signs the user in, forwards `/matter/*` here (prefix removed), drops the
  user's cookies and keys, and sets `x-oma-tenant-id` / `x-oma-user-id`
  together with the shared `x-matter-proxy-secret`. Matter trusts those
  headers only with that secret. Configure the control plane with
  `MATTER_URL` and `MATTER_PROXY_SECRET`; the Console's Feishu page then calls
  `/matter/connect/feishu/...`.

The service (`server.ts`, `main.ts`) runs every connection through a
`MatterAdapter` (`adapter.ts`): the adapter lists the saved connections of its
kind and wires each into an OpenMatter application (integrations, Loops, event
source); the host (`host.ts`) gives each connection its own SQLite store and
inbox, the OpenMA connector and the intake runtime. Two adapters exist:

- Feishu (`feishu-adapter.ts`): one long connection per connected app,
  `feishu-agent` Loop.
- GitLab (`gitlab-adapter.ts`): `POST /connect/gitlab` saves an instance and
  bot token; GitLab webhooks arrive at `POST /webhooks/gitlab/<id>`, are
  persisted before the `202`, and run the `gitlab-mention` Loop. See
  docs/self-host.md.

## Deployment Loops

Loop templates are code. The built-in ones come from the provider packages
(`feishuTemplates`, `gitlabTemplates`); a deployment adds its own at
startup and the Console lists them next to the built-in ones. Nothing is loaded
from users at runtime.

Write each template with `defineLoop` from `@openma/matter-loop`, then start
Matter from your own entry point instead of `main.ts`:

```ts
import { defineLoop } from "@openma/matter-loop";
import { runMatter, type LoopTemplateEntry } from "./run.js";

const standup = defineLoop(
  { id: "team-standup", version: "1.0.0", description: "…", configSchema: { … } },
  (ctx) => { /* register handlers */ },
);

const loops: LoopTemplateEntry[] = [{ provider: "feishu", loop: standup, name: "Team standup" }];
void runMatter({ loopTemplates: loops });
```

`provider` is the Bond the Loop runs on (`feishu` or `gitlab`); `name` is
its display name in the Console (the id otherwise). Matter refuses to start
(exit code 2) if an entry is not a Loop, names another provider, or reuses a
template id. Every replica must register the same templates.

## Operation calls over MCP

The Agent reaches OpenMatter operations, such as the Feishu reply tool, through
an ordinary MCP server configured on the Agent. Because they are ordinary MCP
tools, OpenMA's `tool_search` can defer them like any other MCP tool.

The harness records each MCP call as a session event before running it:
`agent.mcp_tool_use`, or `agent.tool_use` for `mcp_invoke` when the tool was
found through `tool_search`. The connector reads that event from the event log
and reports it to the kernel as an `openmatter/operation` callback whose id is
the tool-use id. The MCP endpoint receives the same call over HTTP and waits on
the bridge until the kernel answers, matching by tool name and arguments
within one OpenMatter Agent Session (the endpoint knows the Session from the
bearer it issued for it).
Deriving the callback from the log keeps a replayed Turn identical to the
original.

A result of `refused`, `failed` or `uncertain` is returned with `isError:
true`. A `conflict` is not an error: it carries the newer messages for the
Agent to read before it decides what to do.

MCP tool names are the OpenMatter tool names with characters outside
`[A-Za-z0-9_-]` replaced by `_` (`feishu.message.reply` →
`feishu_message_reply`).

## Tests

```bash
pnpm --filter @open-managed-agents/matter test
pnpm --filter @open-managed-agents/matter typecheck
```

The tests run the connector against an in-memory stand-in for the public API
(`test/fake-oma.ts`).
