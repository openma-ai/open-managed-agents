# @openma/server

Compose an [OpenMA](https://openma.ai) control plane in Node. It provides
`createApp`, the module/Port binding API, the official application modules, and
`nodeDefaults()`, which wires a store for every storage Port, platform
capabilities and admit-all admission hooks. Pass a value to replace any of
them.

```sh
npm install @openma/server
```

```ts
import { createApp, managedAgentsPortTokens, nodeDefaults } from "@openma/server";

const app = createApp({
  modules: nodeDefaults({
    workspaceId: "ws_1",
    stores: { agents: myAgentStore },          // the rest are in-memory stores
    hooks: { sessionCreate: myAdmissionHook },  // optional; default admits all
  }),
});
await app.start();

const agents = app.port(managedAgentsPortTokens.agents);
await agents.createAgent({ name: "Assistant", model: "claude-sonnet-4-6" });
```

- `createNodePlatform(options)` builds one such app per workspace on first use.
- `@openma/server/modules` exports every module factory and the tokens of the
  outbound Ports they require. Bind one with `providePort(token, value)`.
- Store adapters: [`@openma/stores-memory`](https://www.npmjs.com/package/@openma/stores-memory)
  (default) and [`@openma/stores-sql`](https://www.npmjs.com/package/@openma/stores-sql).
  Port types: [`@openma/core`](https://www.npmjs.com/package/@openma/core).

Guide: [Assemble your own control plane](https://docs.openma.ai/self-host/assemble-control-plane/).
