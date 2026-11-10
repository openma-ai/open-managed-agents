# @openma/sdk

## 1.2.1

### Patch Changes

- da64029: Add npm keywords (claude-managed-agents, openai-agents, self-hosted, sandbox, agent-runtime) so the packages are easier to find.

## 1.2.0

### Minor Changes

- 957e1da: Add eval support (benchmarks → cases → eval runs, Harbor and messages kinds): `client.oma.evals` in the SDK (`benchmarks` list/listBuiltin/create/retrieve/update/delete/upload, `benchmarks.cases` retrieve/add/replace/delete, `runs` create/list/retrieve/cancel/delete/waitForRun) and `oma evals benchmarks …` / `oma evals cases …` / `oma evals run` / `oma evals runs …` in the CLI.
  
  Harbor benchmarks are read-only imports with immutable revisions: new `git` source (github.com / huggingface.co), `benchmarks.sync`/`syncUpload`, `evals.gitRefs({ url })` (branches and tags to pick a ref) and `{ revision }` on benchmark/case retrieve in the SDK; `oma evals benchmarks import --git <url> [--ref] [--path]`, `oma evals benchmarks sync <id> [--ref|--file]` and `--revision N` on benchmark/case show in the CLI. Harbor case add/replace/delete helpers and empty harbor benchmarks are removed.

## 1.1.2

### Patch Changes

- 4fa0828: Bump @anthropic-ai/sdk from 0.120.0 to 1.3.0 and adapt types for the 1.x / API 2026-10-21 breaking changes (including CLI skills list display_name / source.type).

## 1.1.1

### Patch Changes

- 1321265: Point CLI and SDK hosted defaults at live `openma.ai` hosts (`https://app.openma.ai` for Console/API; marketing homepage `https://openma.ai`). `OMA_BASE_URL` / `baseURL` overrides still win.

## 1.1.0

### Minor Changes

- 1599e16: Support the `multiagent_20261001` agent configuration (predefined and inline subagents with pinned versions), paginate agent lists, and list the deployment harness catalog through `oma.harnesses`.

### Patch Changes

- 30f388d: Document how deferred MCP tools are called when the model cannot declare tools mid-conversation: the tool list stays fixed and found tools are called through `mcp_invoke`. Document `tool_search_deferred_hints`, whose default now follows that mode.

## 1.0.2

### Patch Changes

- 57906b3: Pi harness skill mounting strategies (`skill_mount`: `progressive` default, `budgeted`, `tool`, `inline`) replace default full SKILL.md system-prompt inlining for default/Pi harnesses. Deferred skills in `budgeted` mode are discoverable via `tool_search`; `tool` mode adds a `skill` loader tool.

## 1.0.1

### Patch Changes

- 38f58cb: Pi agent-core is the default harness; legacy `ai-sdk` remains available but deprecated (one-time `session.warning` per session). Agents accept compaction via `_oma.context_management` (Anthropic Messages shape) or `_oma.model_settings` (OpenAI Agents SDK shape); conflicting dual definitions are rejected at save time. MCP tool results preserve content blocks on the wire. Agent `max_tokens` above the catalog window is accepted with a warning; pi-ai clamps output per request.
- 2f7c08d: Document agent metadata for deferred MCP `tool_search`: `tool_search` (`auto` | `on` | `off`, default `auto`), optional `tool_search_limit`, `tool_search_auto_threshold`, and `tool_search_always_load`. Backward compatible — omitting `tool_search` keeps automatic exposure when MCP tool definitions exceed a fraction of the model context window.

## 1.0.0

### Major Changes

- 68d2772: Replace the independent Managed Agents client with a composition facade over
  `@anthropic-ai/sdk`, and isolate OpenMA product extensions under `client.oma`.

### Patch Changes

- 7629a91: Expose typed Model Card management and Pi provider metadata through the SDK,
  align model catalog discovery across Node and Cloudflare, and document the
  runtime semantics of effort, speed, and custom Pi model configuration.
- 952fc3f: Add strongly typed `_oma` Agent extensions and the standard sandbox `stdio` MCP transport to create/update payloads while preserving the official Anthropic Managed Agents resource tree.

## 1.0.0-beta.2

### Patch Changes

- 952fc3f: Add strongly typed `_oma` Agent extensions and the standard sandbox `stdio` MCP transport to create/update payloads while preserving the official Anthropic Managed Agents resource tree.

## 1.0.0-beta.1

### Patch Changes

- 7629a91: Expose typed Model Card management and Pi provider metadata through the SDK,
  align model catalog discovery across Node and Cloudflare, and document the
  runtime semantics of effort, speed, and custom Pi model configuration.

## 1.0.0-beta.0

### Major Changes

- 68d2772: Replace the independent Managed Agents client with a composition facade over
  `@anthropic-ai/sdk`, and isolate OpenMA product extensions under `client.oma`.

## 0.1.0

### Minor Changes

- f72a33f: Add a dreams resource with automatic Managed Agents dreaming beta headers.
