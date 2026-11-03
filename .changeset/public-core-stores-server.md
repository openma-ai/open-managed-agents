---
"@openma/core": minor
"@openma/stores-memory": minor
"@openma/stores-sql": minor
"@openma/server": minor
---

First public release of the control-plane building blocks (ADR 0015). `@openma/core` holds the domain models and Ports as types only, with no runtime dependencies. `@openma/stores-memory` and `@openma/stores-sql` implement every storage Port. `@openma/server` composes them with `createApp` and `nodeDefaults()`, so a Node control plane can replace individual stores and admission hooks by passing values.
