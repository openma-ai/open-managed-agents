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
| `OPENSANDBOX_RUNTIME` | unset | Declared server backend: `docker`, `kubernetes` or `fast`. Decides what a pause retains (table below). |
| `OPENSANDBOX_SUSPEND_KIND` | `memory` for `docker`/`fast`, else `filesystem` | Advertised suspend kind. `memory` is refused unless `OPENSANDBOX_RUNTIME` is `docker` or `fast`; set `filesystem` to opt out. |
| `OPENSANDBOX_VOLUMES` | unset | JSON array of official SDK `Volume` objects (`host` / `pvc` / `ossfs`, exactly one each) passed to `Sandbox.create`. Values are never logged or echoed in errors. |
| `OPENSANDBOX_SNAPSHOT_TIMEOUT_MS` / `OPENSANDBOX_SNAPSHOT_POLL_MS` | `600000` / `1000` | Wait for a snapshot to become `Ready`. |
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

## Lifecycle mapping

OpenSandbox pause does **not** freeze `expires_at`: expiry stays absolute
while a sandbox is paused, and the server deletes it on expiry. Pause is for
hot reclaim inside the TTL window. Long-lived files belong in volumes,
external services or explicit snapshots, never in long pause plus renew.

| OpenMA strategy | OpenSandbox primitive | Lifetime | Verification |
| --- | --- | --- | --- |
| `retained_runtime` + `suspend`/`resume` | `Sandbox.pause` / `Sandbox.resume` (same sandbox id) | Hot only, within `expires_at` | Docker: live-certified |
| `durable_mount` | `volumes` on `Sandbox.create` (`pvc` / `ossfs` / `host`) | As durable as the backing volume | Mock-tested only; live-untested |
| `checkpoint_restore` | `SandboxManager.createSnapshot` → `Sandbox.create({ snapshotId })` (new sandbox) | Portable, until the snapshot is deleted | Docker: live-certified |

What a `retained_runtime` pause keeps depends on the backend, so declare it
with `OPENSANDBOX_RUNTIME`. Without a declaration the adapter advertises only
`suspend: ["filesystem"]`, and `suspend({ kind: "memory" })` throws.

| `OPENSANDBOX_RUNTIME` | Pause mechanism | Retains | Status |
| --- | --- | --- | --- |
| `docker` | Container freeze | Files, memory and running processes | Live-verified (process and counter survive pause/resume) |
| `fast` | rootfs + vmstate + guest memory checkpoint | Files and memory, per upstream docs | Untested |
| `kubernetes` (BatchSandbox) | rootfs committed to an OCI image | Files only: no processes or memory (QEMU VMState is an opt-in upstream exception, not assumed). Re-inject credential/egress state after resume. | Untested |

Hooks map to the official SDK only:

- `suspend({ kind })` renews the expiration to `OPENSANDBOX_TIMEOUT_SECONDS`
  (the normal active window) and then calls `Sandbox.pause()`. If renewal fails
  it does not pause. There is no separate long suspended TTL: a paused runtime
  expires one active window after suspend unless the host resumes it. Returns a
  `runtime`-scoped handle for the same sandbox id.
- `resume(handle)` → `Sandbox.resume()` (fresh execd endpoint), then renews
  to `OPENSANDBOX_TIMEOUT_SECONDS`. No-op when already running.
  `sandboxProvider.resume` resumes a paused runtime when attaching by handle.
- `checkpoint({ kind: "filesystem", name })` → `SandboxManager.createSnapshot`,
  polled until `Ready` (`OPENSANDBOX_SNAPSHOT_TIMEOUT_MS`, default 600000;
  `OPENSANDBOX_SNAPSHOT_POLL_MS`, default 1000). Returns a `portable` handle.
  Memory checkpoints are refused.
- `sandboxProvider.restore(handle)` → `Sandbox.create({ snapshotId })`.

Snapshot support depends on the server runtime (HTTP 501 surfaces as
`OpenSandbox snapshot failed (HTTP 501)`). The adapter does not delete
snapshots; operators must garbage-collect them (`SandboxManager.deleteSnapshot`).

### Volumes (`durable_mount`)

```sh
OPENSANDBOX_VOLUMES='[{"name":"ws","pvc":{"claimName":"oma-workspaces"},"mountPath":"/workspace","subPath":"team-a"}]'
```

Docker maps `pvc` to a named volume and Kubernetes to a PersistentVolumeClaim;
`ossfs` needs a Linux FUSE host (Docker) and inline OSS keys; `host` paths must
be under the server's allowed prefixes. Fast Sandbox rejects volumes upstream.
Volumes are fixed at creation, so every create, restore and resume uses the
same definitions. `openSandboxDurableMount(env, mountPath)` returns a
managed-runtime `durableMount` whose identity is credential-free
(`opensandbox:pvc://<claim>/<subPath>#<mountPath>`,
`opensandbox:ossfs://<bucket>@<endpoint>/<subPath>#<mountPath>`) and whose
`attach` verifies the runtime was created with that volume.

### Compositions

Pass `sandboxProvider` to `createProviderManagedRuntime` from
`@open-managed-agents/managed-runtime-sandbox` with
`providerName: "opensandbox"`. A minimal ephemeral composition:

```ts
sandboxCapabilities: { suspendResume: "unsupported", hardTerminate: "supported", runtimeCheckpoints: [] },
workspace: { strategies: ["ephemeral"] },
```

With the mapped lifecycle (here a declared Docker backend and a workspace volume):

```ts
sandboxCapabilities: { suspendResume: "supported", hardTerminate: "supported", runtimeCheckpoints: [] },
workspace: {
  // durable_mount is added automatically when durableMount is supplied.
  strategies: ["retained_runtime", "checkpoint_restore"],
  retainedSuspendKind: "memory",           // "filesystem" unless OPENSANDBOX_RUNTIME=docker|fast
  portableCheckpointKind: "filesystem",
  durableMount: openSandboxDurableMount(env, "/workspace"), // optional
},
```

Select an image containing the OpenMA runtime. The default Node image supports
basic sandbox tools; it does not preinstall an OpenMA worker.

Native background process handles and credential-vault/egress enforcement are
not advertised. OpenSandbox Credential Vault policies require a separate,
explicit mapping to OpenMA's credential egress port.

Run the default tests without an OpenSandbox server:

```sh
pnpm --filter @open-managed-agents/sandbox-adapter-opensandbox test
pnpm --filter @open-managed-agents/sandbox-adapter-opensandbox typecheck
```

These tests run the real SDK against an HTTP test double, and run the stdio
relay as a real local child process. To opt into the live lifecycle, file,
command, renewal, reattachment and binary stdio check, plus pause/resume
(files and, on a declared Docker backend, a running process survive), hot pause
within the active window, resume-by-handle of a paused runtime,
and filesystem snapshot + restore into a new sandbox, configure the connection
variables above and run:

```sh
pnpm --filter @open-managed-agents/sandbox-adapter-opensandbox test:certification
```

The live checks create temporary remote sandboxes and one snapshot, and delete
them in cleanup. The snapshot check needs a server runtime with snapshot support.
