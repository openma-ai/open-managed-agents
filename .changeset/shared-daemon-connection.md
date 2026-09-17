---
"@openma/cli": patch
---

Share daemon connection lifecycle with the desktop host, reconnect silent links without replaying user input, and preserve single execution ownership on attachment conflicts.

Separate owned daemon drain and cleanup from CLI process signals, preserve the output connection until sessions finish, reject new turns during shutdown, and report shutdown failures after cleanup.
