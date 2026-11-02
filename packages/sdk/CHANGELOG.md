# @openma/sdk

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
