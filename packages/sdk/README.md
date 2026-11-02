# @openma/sdk

`@openma/sdk` composes the official Anthropic TypeScript SDK with OpenMA-only
extensions. It does not reimplement Managed Agents resources, pagination,
streaming, errors, or request behavior.

```bash
pnpm add @openma/sdk
```

```ts
import { OpenMA } from "@openma/sdk";

const client = new OpenMA({
  apiKey: process.env.OMA_API_KEY,
});

// The exact @anthropic-ai/sdk Managed Agents resource tree.
const agents = await client.beta.agents.list({ limit: 20 });

// OpenMA product extensions stay in their own namespace.
const available = await client.oma.models.list({
  provider: "deepseek",
});

const card = await client.oma.modelCards.create({
  model_id: "deepseek-fast",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  api_key: process.env.DEEPSEEK_API_KEY!,
});
```

Agent extensions stay on the official resource under the optional `_oma`
namespace and are strongly typed on create, update, Agent responses, and
version-pinned Session snapshots:

```ts
const agent = await client.beta.agents.create({
  name: "reviewer",
  model: { id: "deepseek-main", speed: "fast" },
  _oma: {
    aux_model: { id: "deepseek-aux" },
    appendable_prompts: ["prompt_review"],
    // Omit harness for the Pi agent-core loop (platform default).
    // harness: "ai-sdk" still works but is deprecated (emits session.warning).
  },
});

const session = await client.beta.sessions.create({
  agent: agent.id,
  environment_id: "env_default",
});

console.log(session.agent._oma?.aux_model?.id);
```

## Object model

```ts
client.anthropic // the real @anthropic-ai/sdk client
client.beta      // the same object as client.anthropic.beta
client.oma       // typed /v1/oma/* extensions
client.oma.modelCards // typed Model Card CRUD
```

`client.beta` is an identity alias, not a wrapper. Official SDK types, cursor
pages, SSE streams, retries, request options, and error classes therefore pass
through unchanged.

The provider-discovery endpoint intentionally remains separate from the
official models endpoint:

```ts
await client.beta.models.list();                 // executable tenant cards
await client.oma.models.list({ provider: "openai" }); // Pi provider catalog
```

These are intentionally different catalogs:

| Resource | Meaning | Credentials in request |
|---|---|---|
| `client.beta.models` | The active Model Cards this tenant can execute, projected into the official Managed Agents Model shape | Never |
| `client.oma.models` | Models known by Pi for one built-in provider; useful while creating a card | Never on the SDK-first path |
| `client.oma.modelCards` | Tenant-scoped provider routing, encrypted credential, and Pi model metadata | Only create/rotate accepts `api_key` |

`oma.models.list({ apiKey })` is retained only for 0.x compatibility with the
old Anthropic/OpenAI live-discovery endpoint. New clients should not forward a
provider credential just to browse Pi's catalog.

## Agent model controls

Managed Agents model controls belong to an **Agent version**, not to a Model
Card. A Session pins an Agent version and inherits its controls:

```ts
await client.beta.agents.create({
  name: "fast-researcher",
  model: {
    id: "claude-prod",       // Model Card model_id
    effort: { type: "high" },
    speed: "fast",
    inference_geo: "us",
    provider_options: {
      pi: { reasoning: "off", samplingParams: { temperature: 0 } },
    },
  },
});
```

| Managed field | Runtime behavior |
|---|---|
| `model.id` | Resolves the tenant Model Card, then its wire model and Pi provider. |
| `model.effort` | Maps to Pi `thinkingLevel`. Pi normalizes unsupported levels to the nearest level supported by that model (for example DeepSeek `medium` becomes `high`). |
| `model.speed` | `standard` leaves Pi defaults unchanged. `fast` maps to Anthropic fast mode or OpenAI priority service tier. Other Pi APIs fail explicitly instead of silently ignoring it. |
| `model.inference_geo` | Accepted, versioned, and returned in the official shape. OpenMA currently does not use it for provider/region routing. |
| `model.provider_options` | OpenMA JSON extension for provider-namespaced request options. The main turn and compaction paths receive the main model options; tool-internal model calls receive `_oma.aux_model.provider_options`. Pi-specific request overrides belong under the `pi` key. |

`speed` is request policy and therefore must not be placed in `pi_config`.
Whether a specific effort level is usable is discoverable through
`client.beta.models`; capability flags are conservatively derived from Pi's
model metadata.

Agent create/update bodies are validated JSON objects. The Console's YAML
editor is only an authoring view: it parses YAML into the same structured
request and never stores YAML text. The server normalizes the request into a
versioned Agent document, stores that document as JSON, and atomically retains
the previous document in `managed_agent_versions` on update. Unknown root
fields are rejected; OpenMA fields belong under `_oma`, while model-provider
options belong under `model.provider_options` (or
`_oma.aux_model.provider_options`).

### Deferred MCP tools (`tool_search`)

Pi sessions can hide large MCP tool catalogs behind a built-in `tool_search`
tool. Configure via agent `metadata` (top-level or `_oma` mirror):

| Field | Default | Meaning |
|---|---|---|
| `tool_search` | `auto` | `auto` enables search when deferred MCP definitions exceed `tool_search_auto_threshold` of the model context (token estimate); `on` always defers; `off` exposes every tool. |
| `tool_search_limit` | `8` | Max tools returned per search (1–32). |
| `tool_search_auto_threshold` | `0.1` | Fraction of context window used in `auto` mode. |
| `tool_search_always_load` | `[]` | MCP tool names always exposed without search. |
| `tool_search_deferred_hints` | by mode | How deferred tool names are hinted: `claude_code` (per-turn reminder), `pi` (system-prompt index), `incremental`, or `codex` (none). Defaults to `claude_code` when found tools load directly and `pi` when they are called through `mcp_invoke`. |

How a found tool is called depends on the model's Pi `compat`:

- With mid-conversation tool declarations (`supportsMidConvoSystemMessages` plus
  `supportsMidConvoToolChanges` or `supportsMidConvoToolAdditions`), found tools
  are declared for the next model turn and called by name. Loaded tools persist
  in the session event log and are restored on harness resume.
- Otherwise the tool list stays fixed for the session: `tool_search` returns each
  tool's schema and the model calls it through `mcp_invoke` with
  `{"tool_name": ..., "arguments": {...}}`, so loading a tool does not
  invalidate the cached prompt prefix. Arguments are validated against the
  target's schema, and `always_ask` targets pause for confirmation like direct
  calls.

### Skill mounting (`skill_mount`)

Pi / default harnesses expose skills through the assembly layer instead of inlining every `SKILL.md` into the system prompt:

| Field | Default | Meaning |
|---|---|---|
| `skill_mount` | `progressive` | List name, description, and sandbox path; read `SKILL.md` on demand (pi coding-agent style). |
| `skill_mount` | `budgeted` | Skill list capped by `skill_list_budget` (fraction of context); overflow skills deferred to `tool_search`. |
| `skill_mount` | `tool` | Index in system prompt; call built-in `skill` to load `SKILL.md` for the next turn. |
| `skill_mount` | `inline` | Legacy behavior — full `SKILL.md` bodies in the system prompt. |
| `skill_list_budget` | `0.02` | List token budget fraction for `budgeted` mode. |
| `skill_description_max_chars` | `1024` | Per-skill description cap in list modes. |

## Pi-backed Model Cards

`provider` is an open Pi provider id (`anthropic`, `openai`, `deepseek`,
`openrouter`, and so on). Migration aliases `ant`, `oai`,
`ant-compatible`, and `oai-compatible` remain accepted. For a custom provider,
set `base_url` and provide `pi_config.api` so Pi can choose the wire protocol.

`pi_config` exposes only Pi's serializable Model metadata:

```ts
await client.oma.modelCards.create({
  model_id: "private-vllm",
  provider: "my-vllm",
  model: "org/model-1",
  base_url: "https://llm.example/v1",
  api_key: process.env.PRIVATE_LLM_KEY!,
  pi_config: {
    api: "openai-completions",
    name: "Private model",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
});
```

Card identity (`model_id`), wire model (`model`), provider, endpoint, headers,
and credential remain first-class Card fields and cannot be overridden through
`pi_config`. List/retrieve responses never return the credential, only its
preview. A create probe returning `unsupported_provider` means the legacy
six-second probe could not exercise that Pi provider; it does not mean Pi
cannot execute the card.

Extensions without a typed resource yet can use the guarded escape hatch. It
accepts only `/v1/oma/*` paths and still runs through the official transport:

```ts
const stats = await client.oma.request<{ agents: number }>({
  method: "get",
  path: "/v1/oma/stats",
});
```

## Configuration

All official `@anthropic-ai/sdk` client options are accepted. OpenMA defaults
`baseURL` to `https://openma.dev` and adds one optional workspace header:

```ts
new OpenMA({
  apiKey: "oma_...",
  baseURL: "https://openma.example",
  activeTenantId: "tn_...",
});
```

`baseUrl` and `bearer` remain deprecated migration aliases for `baseURL` and
`authToken`. Browser callers must explicitly use the official
`dangerouslyAllowBrowser` option and should only do so with an appropriate
cookie/token security model.

## Migrating from 0.x

| 0.x | 1.x |
|---|---|
| `client.agents` | `client.beta.agents` |
| `client.sessions` | `client.beta.sessions` |
| `client.environments` | `client.beta.environments` |
| `client.memoryStores` | `client.beta.memoryStores` |
| `client.dreams` | `client.beta.dreams` |
| `baseUrl` | `baseURL` |
| `bearer` | `authToken` |
| `OpenMAError` | official `APIError` subclasses from `@anthropic-ai/sdk` |

The 1.x methods use the official SDK parameter and return shapes. There are no
top-level Managed resource aliases because keeping the old names with different
method semantics would create silent migration bugs.
