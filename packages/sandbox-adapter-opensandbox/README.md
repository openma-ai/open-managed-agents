# OpenSandbox adapter

Implementation of OpenMA's `SandboxProviderPort` and `SandboxFactory` backed by
the official [`@alibaba-group/opensandbox`](https://github.com/opensandbox-group/OpenSandbox/tree/main/sdks/sandbox/javascript)
TypeScript SDK. The SDK owns lifecycle requests, readiness, command streams,
file transfer, lease renewal and endpoint discovery. The package is private.

The SDK is an optional peer dependency, matching the other provider adapters.
Source installs include version `1.1.1` as a development dependency for tests;
production-only packaging must install the selected provider's peer SDK:

```sh
npm install @alibaba-group/opensandbox@^1.1.1
```

SDK creation telemetry is disabled. API keys remain in the SDK's control-plane
connection configuration and are not forwarded as sandbox environment variables.

Start a Docker-backed server as in the upstream
[Harbor example](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/examples/harbor-evaluation.md):

```sh
uv pip install opensandbox-server
opensandbox-server init-config ~/.sandbox.toml --example docker
opensandbox-server
```

Configure the OpenMA Node server:

```sh
SANDBOX_PROVIDER=opensandbox
OPENSANDBOX_DOMAIN=localhost:8080
OPENSANDBOX_API_KEY=your-server-key
SANDBOX_IMAGE=node:22-slim
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENSANDBOX_DOMAIN` | `localhost:8080` | Server `host[:port]`, matching Harbor. |
| `OPENSANDBOX_API_KEY` | unset | Lifecycle API key; optional for a no-auth development server. `OPEN_SANDBOX_API_KEY` is the official SDK-compatible fallback name. |
| `OPENSANDBOX_PROTOCOL` | `http` | `http` or `https` for domain and scheme-less service endpoints. |
| `OPENSANDBOX_TIMEOUT_SECONDS` | `1800` | Initial sandbox lifetime, integer seconds, minimum `60`. OpenMA renews active runtime leases via `renew-expiration`. |
| `OPENSANDBOX_READY_TIMEOUT_MS` | `120000` | Provisioning and execd readiness deadline in milliseconds. |
| `OPENSANDBOX_CPU` | `1` | OpenSandbox `resourceLimits.cpu` quantity. |
| `OPENSANDBOX_MEMORY` | `1Gi` | OpenSandbox `resourceLimits.memory` quantity. |
| `SANDBOX_IMAGE` | `node:22-slim` | Prebuilt container image. Must provide Node.js, `sh`, `tail`, and any selected harness/runtime executables. |

The domain/key names follow Harbor. Configure the address with
`OPENSANDBOX_DOMAIN=host[:port]`; the SDK constructs its lifecycle API URL.
Resource and timeout variables are OpenMA adapter configuration, mapped to the upstream OpenAPI fields.
The OpenMA host must reach endpoints returned by the server for execd (44772)
and stdio relays (random ports 45000–64999). Configure Docker host addressing or the
OpenSandbox gateway accordingly; endpoint response headers are honored.

Commands run in `/workspace`; relative file paths are rooted there. Files are
binary safe. `sandboxProvider.resume` attaches an existing runtime by its
persisted handle, resuming it first (SDK `Sandbox.resume`) when it is paused. Creation uses the SDK's endpoint and execd health checks; failed
provisioning deletes the allocation. Destroy is idempotent and retries remain
possible after an HTTP failure.

For harness-in-sandbox, the adapter starts an authenticated Node stdio relay
through execd and resolves its service endpoint through OpenSandbox. This
provides raw duplex streams without PTY line processing. OpenMA's private
worker/supervisor protocol remains unchanged. The lifecycle API key stays on
the control plane and is never added to commands, container environment, or
file uploads. Relay authentication uses a random, per-process token.

Managed runtime hosts can pass the exported `sandboxProvider` directly to
`createProviderManagedRuntime` from `@open-managed-agents/managed-runtime-sandbox`
with `providerName: "opensandbox"`, `sandboxCapabilities: { suspendResume:
"unsupported", hardTerminate: "supported", runtimeCheckpoints: [] }`, and
`workspace: { strategies: ["ephemeral"] }`. Compositions may also opt in to
`"retained_runtime"` (`retainedSuspendKind: "memory"`) and/or
`"checkpoint_restore"` (`portableCheckpointKind: "filesystem"`) once their
OpenSandbox runtime is certified for pause and snapshots (see below). Select an image containing the
OpenMA runtime and supply the usual runtime environment verification and
harness configuration. The default Node image supports basic sandbox tools;
it does not preinstall an OpenMA worker.

Lifecycle hooks map to the official SDK only:

- `suspend({ kind })` → `Sandbox.pause()`. Returns a `runtime`-scoped handle
  for the same sandbox id. On the Docker runtime this freezes the container, so
  files, memory and running processes are retained.
  OpenSandbox's expiry timer keeps running while a sandbox is paused and
  deletes it on expiry (Docker and Kubernetes). Suspend therefore first renews
  the expiration to `OPENSANDBOX_SUSPENDED_TTL_SECONDS` (default 86400, min 60)
  and only pauses if that renewal succeeded. This is the retention window for a
  retained runtime.
- `resume(handle)` → `Sandbox.resume()` (fresh execd endpoint), then renews the
  expiration back to `OPENSANDBOX_TIMEOUT_SECONDS`; a no-op when the sandbox is
  already running. Attaching a paused runtime via `sandboxProvider.resume` does
  the same.
- `checkpoint({ kind: "filesystem", name })` → `SandboxManager.createSnapshot`,
  polled with `getSnapshot` until `Ready` (`OPENSANDBOX_SNAPSHOT_TIMEOUT_MS`,
  default 600000; `OPENSANDBOX_SNAPSHOT_POLL_MS`, default 1000). Returns a
  `portable` handle. Memory checkpoints are refused: snapshots do not capture
  processes.
- `sandboxProvider.restore(handle)` → `Sandbox.create({ snapshotId })`, a new
  sandbox with the snapshot's filesystem.

Snapshot support depends on the server runtime (servers without it answer
HTTP 501, surfaced as `OpenSandbox snapshot failed (HTTP 501)`). The adapter
does not delete snapshots; the OpenMA port has no snapshot deletion hook, so
operators must garbage-collect them (`SandboxManager.deleteSnapshot`).

Native background process handles, durable workspace or memory mounts, and credential-vault/egress enforcement are not
advertised by this adapter. OpenSandbox Credential Vault policies require a
separate, explicit mapping to OpenMA's credential egress port; no enforcement
is inferred from provider selection.

Run the default tests without an OpenSandbox server:

```sh
pnpm --filter @open-managed-agents/sandbox-adapter-opensandbox test
pnpm --filter @open-managed-agents/sandbox-adapter-opensandbox typecheck
```

These tests run the real SDK against an HTTP test double, and run the stdio
relay as a real local child process. To opt into the live lifecycle, file,
command, renewal, reattachment and binary stdio check, plus pause/resume
(files and a running process survive), resume-by-handle of a paused runtime,
and filesystem snapshot + restore into a new sandbox, configure the connection
variables above and run:

```sh
pnpm --filter @open-managed-agents/sandbox-adapter-opensandbox test:certification
```

The live checks create temporary remote sandboxes and one snapshot, and delete
them in cleanup. The snapshot check needs a server runtime with snapshot support.
