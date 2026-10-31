---
"@openma/cli": patch
---

Fix `oma connect` to use authenticated MCP OAuth authorization and result polling with a private, single-use claim credential. Keep API keys and client secrets out of browser URLs and remove the random localhost callback listener.
