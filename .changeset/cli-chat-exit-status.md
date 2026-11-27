---
"@openma/cli": patch
---

`oma sessions chat` no longer exits 0 for a turn that did not finish. It exits 3 with the pending event ids when the session stops on `requires_action`, and exits 1 with a message on a stream `error` frame, `session.status_terminated` (previously it hung), a stop reason other than `end_turn`, or a stream that closes before the session goes idle.
