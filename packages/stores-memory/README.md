# @openma/stores-memory

In-memory adapters for every [`@openma/core`](https://www.npmjs.com/package/@openma/core)
storage Port. State lives in the process and is gone on restart. Use them for
tests, local development, or as reference implementations when you write your
own store.

```sh
npm install @openma/stores-memory
```

```ts
import { MemoryAgentStore, memoryStores } from "@openma/stores-memory";

const stores = memoryStores();                         // one store per Port
const withMine = memoryStores({ agents: myAgentStore }); // keep yours, fill the rest
```

`memoryStores()` wires stores that read each other (Session resources and
events read Sessions; Deployment runs read Deployments) to the store you pass.

[`@openma/server`](https://www.npmjs.com/package/@openma/server) `nodeDefaults()`
uses these stores for every store you do not pass.
