---
"@openma/cli": patch
---

Reuse one embedded LiteBox provider per Runtime sandbox registry and honor optional BOXLITE_HOME so concurrent sessions do not deadlock on the home lock.
