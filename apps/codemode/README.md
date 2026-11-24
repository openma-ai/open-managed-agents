# Code-mode sandbox worker

This Worker hosts the QuickJS Durable Object used by the optional `codemode`
agent tool. Deploy it before deploying `apps/agent` when an agent enables that
tool.

```bash
pnpm deploy:codemode
```

The agent worker binds this namespace as `CODEMODE_SANDBOX`. Node deployments
can use `@open-managed-agents/agent-harness/codemode-node`, which runs the same
QuickJS runtime in a worker thread.
