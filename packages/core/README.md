# @openma/core

The OpenMA contract: domain models and Ports, as TypeScript types only. It has
no runtime code and no runtime dependencies.

Depend on it when you implement a store, an admission hook or another adapter
for an [OpenMA](https://openma.ai) control plane.

```sh
npm install @openma/core
```

```ts
import type { AgentStore, ControlPlaneStores } from "@openma/core/storage";
import type { SessionCreateAdmissionHookPort } from "@openma/core";
```

| Subpath | Contents |
|---|---|
| `@openma/core` | Inbound application Ports, their commands/results/views, outbound source and runtime Ports, admission hooks |
| `@openma/core/ports[/<resource>]` | Inbound application Port per resource |
| `@openma/core/storage[/<resource>]` | Storage Ports (`AgentStore` … `VaultStore`) and `ControlPlaneStores` |
| `@openma/core/runtime/<capability>` | Session runtime command and stream Ports |
| `@openma/core/domain[/<resource>]` | Domain models shared by both sides of the Ports |

Ready-made adapters: [`@openma/stores-memory`](https://www.npmjs.com/package/@openma/stores-memory),
[`@openma/stores-sql`](https://www.npmjs.com/package/@openma/stores-sql).
Composition: [`@openma/server`](https://www.npmjs.com/package/@openma/server).

## Versioning

Any change to an exported Port or type is a **major** release, including a new
method on a storage Port or a new member of a result union. New exports are
minor. See [ADR 0015](https://github.com/openma-ai/open-managed-agents/blob/main/docs/adr/0015-public-core-stores-server-packages.md).
