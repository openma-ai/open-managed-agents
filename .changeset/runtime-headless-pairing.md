---
"@openma/cli": patch
---

Add headless runtime pairing: `oma runtime pair [--ttl <seconds>]` mints a one-time setup command, and `oma bridge setup --token <omrp_…>` (or `OMA_PAIRING_TOKEN`) pairs a machine without a browser.
