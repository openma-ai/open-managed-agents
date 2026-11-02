<p align="center">
  <img src="logo.svg" alt="Open Managed Agents" height="80" />
</p>

# Open Managed Agents

**Any model. Any harness. Any sandbox. Any cloud.**

OpenMA handles sessions, execution and recovery, so you can build and run agents with any model, any harness, any sandbox, on any cloud. An open-source, self-hostable alternative to Claude Managed Agents and OpenAI Agents API.

**Your choice of infrastructure, too.** Use built-in adapters or plug in your own database, queue, and object storage.

[Try hosted](https://app.openma.ai/login) · [Self-host](#self-hosting) · [For agents](#for-agents) · [API examples](#apis-and-compatibility) · [Documentation](https://docs.openma.ai) · [Apache-2.0](LICENSE) · [中文](README.zh-CN.md)

[![OpenMA Console: Agent configuration, integrations, and version history in light mode](docs/assets/console/agent-light.png)](docs/assets/console/agent-light.png)

<table>
  <tr>
    <th width="50%">Model configuration</th>
    <th width="50%">Execution environment</th>
  </tr>
  <tr>
    <td><a href="docs/assets/console/model-setup-light.png"><img src="docs/assets/console/model-setup-light.png" alt="Model provider selection and configuration in light mode" width="100%" /></a></td>
    <td><a href="docs/assets/console/environment-light.png"><img src="docs/assets/console/environment-light.png" alt="Environment networking and package configuration in light mode" width="100%" /></a></td>
  </tr>
</table>

*Actual Console UI with synthetic demo data. Integration statuses and configurations are illustrative. Click a screenshot to view it at full size.*

## Build on managed execution

Create an agent, give it work, and return to the same session later. OpenMA provides:

- **Durable sessions and recovery.** Preserve conversation history, stream progress, and coordinate execution attempts without tying the session to one process. Workspace checkpoints and retained outputs support recovery with the configured runtime.
- **Tools and integrations you can reuse.** Start with shell, file, web, and browser tools. Add MCP services and Skills, then connect agents to the platforms where your team works.
- **Control over your deployment.** Choose the model, harness, sandbox, and backend services independently. Operate through the Console, CLI, or API.

If OpenMA is useful to you, give the repository a **Star**. Use **Watch → Custom → Releases** for release notifications.

## For agents

Install the [deployment skill](skills/deploy-openma/SKILL.md) for your coding agent:

```bash
npx skills add openma-ai/open-managed-agents --skill deploy-openma
```

Then ask: **“Deploy OpenMA on this machine.”** Your agent checks the environment, prepares configuration, deploys the platform, and verifies the Console and an agent task. It asks for the target, login or credentials when needed, and confirms paid cloud resources before creating them. The command installs the guide; deployment starts when you ask your agent.

## Choose your stack

| Layer | Existing integrations and extension points |
| --- | --- |
| **Models** | Anthropic, OpenAI, DeepSeek, OpenRouter and other Pi providers; custom endpoints through [Model Cards](packages/sdk/README.md#pi-backed-model-cards) |
| **Harnesses** | Built-in Pi; Claude Code, Codex and other agents through [ACP adapters](packages/harness-runtime-acp/README.md); [custom harnesses](#architecture-platform-harness-sandbox) |
| **Sandboxes** | E2B, Daytona, LiteBox, Cloudflare Sandbox and more; see [provider capabilities](apps/docs/src/content/docs/self-host/managed-runtime-host.mdx) |
| **Deployment** | Native Node.js, Docker, Fly.io, Vercel (Beta), Cloudflare; [deployment paths](#self-hosting) |
| **Database** | SQLite, PostgreSQL, MySQL, Cloudflare D1 and Durable Object SQL adapters; [SQL client and Store interfaces](docs/v1-architecture.md) |
| **Queue** | SQL-backed queues, Cloudflare Queues and an in-memory adapter; [Queue and dead-letter contracts](packages/queue/src/ports.ts) |
| **Object storage** | S3-compatible storage, Cloudflare R2, local filesystem and in-memory blob adapters; [BlobStore](packages/blob-store/src/ports.ts) |

Use the included adapters or implement an extension. “Any” means you can extend these interfaces; available features and setup depend on the selected adapters. Follow the linked provider and deployment guides for requirements.

## Architecture: platform, harness, sandbox

OpenMA is a **meta-harness**: it manages the resources and lifecycle around an agent loop. Choose the execution path that fits your agent.

### Harness outside the sandbox: independent lifecycles

Run the model loop outside the sandbox and use the sandbox to execute tools. Keep session history separate from both, so a sandbox failure does not erase the conversation and a replacement harness can rebuild context from durable events. Manage execution resources without coupling them to the lifetime of the agent loop.

Use the built-in Pi harness or implement the [host-side harness interface](apps/agent/src/harness/interface.ts). Workspace restoration depends on the configured persistence and provider; the [Runtime Host guide](apps/docs/src/content/docs/self-host/managed-runtime-host.mdx#session-brain-placement-and-scaling) describes ownership and recovery.

### Harness inside the sandbox: reuse a mature agent

Bring Claude Code, Codex, or another established harness into a managed sandbox. Reuse its agent loop, context management, tools, and skills rather than rebuilding those capabilities. OpenMA supplies the surrounding work lifecycle, workspace persistence, and output collection.

The [ACP runtime](packages/harness-runtime-acp/README.md) provides existing integrations, including versioned harness installation independent of the sandbox image. Custom harnesses can use the [supervisor contract](packages/harness-supervisor/src/index.ts); ACP is one option. Native features and session resume depend on the selected adapter.

## Tools and integrations, already connected

| Capability | What you can use |
| --- | --- |
| **Code and files** | Shell execution, file read/write/edit, glob and text search |
| **Web research** | Web search and page fetching |
| **Browser automation** | Navigation, clicks, text input, page reading and screenshots; opt in and configure a browser backend |
| **MCP and Skills** | External tool servers and reusable task instructions; Pi supports deferred tool discovery and on-demand skill loading |
| **Session resources** | Attach repositories, files, and persistent memory stores with session-scoped access |
| **Workplace integrations** | GitHub issues and PRs, Linear issues, Slack threads, and Feishu chats |

Combine repository tools with GitHub for issue investigation, or web tools with Slack for a research assistant. Reuse the same tools and skills across more agents instead of building a new integration stack for each workflow. Configure the required service credentials and permissions; in-sandbox harnesses use their native tools and adapter-provided capabilities.

[Built-in tools](apps/agent/src/harness/tools.ts) · [Browser](packages/browser-harness/) · [MCP and Skills](packages/sdk/README.md) · [Integrations](apps/docs/src/content/docs/build/integrations.mdx)

## Scale the execution as your workloads grow

Tool reuse helps you add workflows. For more concurrent sessions, Node deployments can use shared PostgreSQL or MySQL and compatible storage/runtime services across replicas. For harnesses outside the sandbox, replicas claim different sessions in parallel through a durable execution outbox, renewable leases, and fencing; work within a session stays ordered. In-sandbox harnesses use the separate Environment Work claim, rather than nesting a second Session execution claim.

The single-host SQLite quickstart is a separate deployment choice. Capacity depends on the database, storage, sandbox provider, and model limits; see [session execution and scaling](apps/docs/src/content/docs/self-host/managed-runtime-host.mdx#session-brain-placement-and-scaling).

## Complete the work loop with OpenMatter

**Integration status:** [OpenMatter](https://github.com/openma-ai/OpenMatter) implements the Loop runtime. Unified Bond/Loop hosting in this OpenMA revision remains a [proposed integration](docs/adr/0011-matter-bond-and-loop.md).

OpenMatter connects work events to authorized context, agent turns, and recorded results delivered back to the work system. OpenMA supplies the agent execution infrastructure.

```text
Work event → authorized context → agent execution → result delivery
     ↑                                                   │
     └──────────────── follow-up feedback ────────────────┘
```

An issue-to-PR workflow can investigate an issue, prepare a change, post the result, then use review feedback for the next turn. The same pattern can support OpenMA's own development. This is a workflow to compose with application-defined permissions and approvals, not a preconfigured auto-merge bot.

## Support and boundaries

- **API coverage:** Claude Managed Agents and OpenAI Agents API have separate contracts. Both use OpenMA's native infrastructure; the OpenAI adapter's limits do not describe the entire platform. See [API examples and compatibility](#apis-and-compatibility).
- **Delegation:** Node's OpenAI path supports creating, messaging, waiting on, interrupting, closing, and resuming subagents with independent histories and a shared sandbox. Its execution baseline is single-level delegation; hosted Cloudflare coverage differs. See the [compatibility report](docs/openai-agents-compatibility-status.md).
- **Credentials:** Model Cards encrypt provider keys at rest. Vault-backed gateways support scoped access to private services; enforced credential isolation depends on the provider and runtime profile. See [credential egress requirements](apps/docs/src/content/docs/self-host/managed-runtime-host.mdx#credential-egress).
- **Backend extensions:** New adapters must preserve required transaction, claim/retry, and conditional-write semantics. Background queues, Session execution claims, and Environment Work have distinct contracts. See [Node composition](apps/main-node/src/components.ts) and [architecture](docs/v1-architecture.md).

<a id="two-ways-to-run-oma"></a>

## Self-hosting

| Deployment | Setup | Notes |
| --- | --- | --- |
| **Native Node.js / Docker** | [Quickstart below](#quick-start-self-host-docker) · [Node guide](https://docs.openma.ai/self-host/node-docker/) | Configure isolated execution and persistent storage |
| **Fly.io** | [Fly guide](apps/docs/src/content/docs/self-host/fly.mdx) | Node control plane with a pinned server image |
| **Vercel (Beta)** | [Configurator](https://openma.ai/deploy/) · [Adapter](apps/main-vercel/) | Separate database, object storage, and sandbox setup; serverless runtime boundaries apply |
| **Cloudflare** | [Setup wizard](#quick-start-cloudflare-deploy) | Provisions resources in your account |

<a id="quick-start-self-host-docker"></a>

### Node / Docker

Use the [deployment skill](#for-agents) to let your coding agent handle setup, or follow the manual steps below.

<details>
<summary>Manual Docker setup</summary>

Install Docker with Compose, then:

```bash
git clone https://github.com/openma-ai/open-managed-agents.git
cd open-managed-agents
cp .env.example .env
```

Edit `.env` before starting:

- Generate `BETTER_AUTH_SECRET` with `openssl rand -hex 32` and `PLATFORM_ROOT_SECRET` with `openssl rand -base64 32`. Store both securely; back up the encryption root with your data.
- Select an isolated `SANDBOX_PROVIDER` (`litebox`, `boxrun`, `daytona`, `e2b`, or [OpenSandbox](packages/sandbox-adapter-opensandbox/README.md)) and supply its configuration. The deployment does not fall back to running agent commands in an unisolated host subprocess.
- Configure the provider's network, storage, and credential-proxy requirements. Remote sandboxes need reachable services; a private Docker hostname alone is not enough.
- Set `PUBLIC_BASE_URL` for your deployment. Leave authentication enabled. Configure model access through Console Model Cards, or the documented environment fallback.

```bash
docker compose up -d --build
curl --fail http://localhost:8787/health
```

Open `http://localhost:8787`, create your account, then configure a model and environment. The Compose stack mounts `./data`; keep it when restarting or upgrading. A successful `/health` response confirms server readiness, not that a model or sandbox task has succeeded.

Read the [Node deployment guide](https://docs.openma.ai/self-host/node-docker/), [environment template](.env.example), and [Compose configuration](docker-compose.yml) before exposing the service publicly.

</details>

### Quick start: Cloudflare deploy

Use the Node version in [`.node-version`](.node-version), the repository's pinned pnpm version, Docker for container builds, `jq`, and `openssl`. Authenticate to a Cloudflare account with the required Workers/Containers services enabled.

```bash
git clone https://github.com/openma-ai/open-managed-agents.git
cd open-managed-agents
pnpm install --frozen-lockfile
npx wrangler login
pnpm setup:cloudflare
```

The script provisions Cloudflare resources, updates the local Wrangler configuration, sets secrets, and deploys the Workers. It currently prompts for an Anthropic API key unless supplied in the environment. Review [`scripts/setup-cf.sh`](scripts/setup-cf.sh) and the [deployment guide](apps/docs/src/content/docs/self-host/deploy.mdx) before running it; this creates cloud resources and may incur charges. Use the URL printed by your deployment, not OpenMA's hosted domain.

## APIs and compatibility

| Interface | Purpose | Reference |
| --- | --- | --- |
| **Claude Managed Agents**, `/v1/*` | Agents, environments, sessions, events, and worker contracts through the official Anthropic SDK | [Contract tests](packages/managed-agents-api/) · [SDK E2E](test/e2e/managed-agents-sdk.mjs) |
| **OpenAI Agents API**, `/openai/v1/*` | OpenAI SDK calls mapped to native OpenMA agents, sessions, and execution | [Adapter](packages/openai-agents-compat/README.md) · [Compatibility report](docs/openai-agents-compatibility-status.md) |
| **OpenMA extensions**, `/v1/oma/*` | Model Cards and product-specific features | [OpenMA SDK](packages/sdk/README.md) |

OpenMA is an independent implementation. Check the API and runtime coverage before migrating.

### Claude Managed Agents API

First create an OpenMA API key, a Model Card, and an environment in the Console. Set `OPENMA_API_KEY`, `OPENMA_MODEL_ID` (the Model Card's `model_id`, not its database record ID), and `OPENMA_ENVIRONMENT_ID`. For self-hosting, set `OPENMA_BASE_URL` to your server origin without a trailing slash, such as `http://localhost:8787`.

The repository pins the official Anthropic SDK to `0.120.0`:

```bash
npm install @anthropic-ai/sdk@0.120.0
```

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.OPENMA_API_KEY,
  baseURL: process.env.OPENMA_BASE_URL ?? "https://app.openma.ai",
});

const agent = await client.beta.agents.create({
  name: "researcher",
  model: process.env.OPENMA_MODEL_ID!,
  system: "Help me investigate a task and explain your findings.",
});

const session = await client.beta.sessions.create({
  agent: { type: "agent", id: agent.id, version: agent.version },
  environment_id: process.env.OPENMA_ENVIRONMENT_ID!,
});

await client.beta.sessions.events.send(session.id, {
  events: [{
    type: "user.message",
    content: [{ type: "text", text: "Help me plan a code review." }],
  }],
});

console.log(session.id);
```

Open that session in the Console to follow the task. The [official SDK E2E](test/e2e/managed-agents-sdk.mjs) also demonstrates event streaming and continuation. For typed OpenMA extensions, use [`@openma/sdk`](packages/sdk/README.md), which composes the official Anthropic SDK.

### OpenAI Agents API quickstart

Use the same OpenMA API key and a configured Model Card. This adapter's tested SDK baseline is `openai@7.15.0`:

```bash
npm install openai@7.15.0
```

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENMA_API_KEY,
  baseURL: `${process.env.OPENMA_BASE_URL ?? "https://app.openma.ai"}/openai/v1`,
});

const events = await client.beta.agents.sessions.create({
  agent: {
    model: process.env.OPENMA_MODEL_ID!,
    instructions: "Help me investigate a task and explain your findings.",
  },
  environment: { type: "none" },
  input: "Help me plan a code review.",
  stream: true,
});

for await (const event of events) console.log(event);
```

This example requests no sandbox. Node and hosted Cloudflare support this session path. OpenAI dynamic subagent controls currently require Node and use single-level delegation. Advanced environment, plugin, and some model/tool settings have additional limits; these adapter limits do not describe the whole OpenMA platform. See the [compatibility report](docs/openai-agents-compatibility-status.md).

## Development and community

Use the versions in [`.node-version`](.node-version) and [`package.json`](package.json):

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

[Contributing](CONTRIBUTING.md) · [Issues](https://github.com/openma-ai/open-managed-agents/issues) · [Security reports](SECURITY.md) · [Discord](https://discord.gg/P3EfQFm5bD) · [OMA CLI](packages/cli/README.md) · [Website](https://openma.ai)

## License

[Apache-2.0](LICENSE). See individual package manifests and [`NOTICE`](NOTICE) for package and third-party license information.
