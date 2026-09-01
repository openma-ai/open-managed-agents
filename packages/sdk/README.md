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
  provider: "ant",
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
```

## Object model

```ts
client.anthropic // the real @anthropic-ai/sdk client
client.beta      // the same object as client.anthropic.beta
client.oma       // only /v1/oma/* extensions
```

`client.beta` is an identity alias, not a wrapper. Official SDK types, cursor
pages, SSE streams, retries, request options, and error classes therefore pass
through unchanged.

The provider-discovery endpoint intentionally remains separate from the
official models endpoint:

```ts
await client.beta.models.list();
await client.oma.models.list({ provider: "oai", apiKey: "sk-..." });
```

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
