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
| `OPENSANDBOX_TEMPLATE_ID` | unset | Required for new `fast` sandboxes: ID of a `Succeeded` OpenSandbox template. Uses `Sandbox.createFromTemplate`; requires `OPENSANDBOX_RUNTIME=fast`. |
| `OPENSANDBOX_SUSPEND_KIND` | `memory` for `docker`/`fast`, else `filesystem` | Advertised suspend kind. `memory` is refused unless `OPENSANDBOX_RUNTIME` is `docker` or `fast`; set `filesystem` to opt out. |
| `OPENSANDBOX_VOLUMES` | unset | JSON array of official SDK `Volume` objects (`host` / `pvc` / `ossfs`, exactly one each) passed to `Sandbox.create`. Values are never logged or echoed in errors. |
| `OPENSANDBOX_SNAPSHOT_TIMEOUT_MS` / `OPENSANDBOX_SNAPSHOT_POLL_MS` | `600000` / `1000` | Wait for a snapshot to become `Ready`. |
| `OPENSANDBOX_READY_TIMEOUT_MS` | `120000` | Provisioning, pause completion and execd readiness deadline in milliseconds. |
| `OPENSANDBOX_CPU` | `1` | OpenSandbox `resourceLimits.cpu` quantity for container sandboxes. Fast Sandbox uses its template and pool profile. |
| `OPENSANDBOX_MEMORY` | `1Gi` | OpenSandbox `resourceLimits.memory` quantity for container sandboxes. Fast Sandbox uses its template and pool profile. |
| `SANDBOX_IMAGE` | `node:22-slim` | Prebuilt container image. Must provide Node.js, `sh`, `tail`, and any selected harness/runtime executables. |

The domain/key names follow Harbor. Configure the address with
`OPENSANDBOX_DOMAIN=host[:port]`; the SDK constructs its lifecycle API URL.
Resource and timeout variables are OpenMA adapter configuration, mapped to the upstream OpenAPI fields.
For Fast Sandbox on a Kubernetes server, set `OPENSANDBOX_RUNTIME=fast` and `OPENSANDBOX_TEMPLATE_ID=<succeeded-template-id>`. Build the template from an image containing Node.js, `sh`, `tail`, and the selected runtime executables. Template creation fixes the workload image, resources and entrypoint, so `SANDBOX_IMAGE`, `OPENSANDBOX_CPU` and `OPENSANDBOX_MEMORY` do not override them. Snapshot restore uses `snapshotId`, not the configured template, and inherits the Fast Sandbox pool profile. Declaring `fast` without a template fails before creating an image-backed container sandbox; volumes are rejected locally. Attaching by runtime handle and restoring a snapshot do not require a template ID.
Fast Sandbox HA deployments also need an ingress gateway that resolves current FastPath routes for every request. Gateways that cache routes per replica can return a stale-route HTTP 503 after pause/resume despite another replica's successful health check; update the gateway rather than replaying mutating commands.
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

Exit observation uses short authenticated `/exit` queries (204 while running,
otherwise the actual exit code/signal), retried against that same relay identity.
Queries have a one-second deadline and run every 250ms; three consecutive
failures reject observation with the original cause and sandbox/port/timestamp.
A failed query or acknowledged kill is **not** evidence of child exit. ACP
cleanup still refuses native-state capture/deletion without confirmed exit and
retains the transport cause, ACP session ID, phase and elapsed time on its error.

Raw stdout/stderr use Undici requests with a bounded header wait and no body
idle timeout, so a silent turn can exceed five minutes without injecting
heartbeat bytes into the protocol. A real stream disconnect is not replayed:
missing bytes cannot safely be reconstructed. Reverse proxies must allow idle
streaming connections for the intended turn duration. A permanent loss of exit
observation aborts the local stdio readers; the execution owner remains
responsible for stopping the child. The relay retains its exit result for
30 seconds after the child exits.

## Sandbox SDK v2 (explicit composition)

`@open-managed-agents/sandbox-adapter-opensandbox/v2` exports
`createOpenSandboxV2Adapter`. This is a native lifecycle adapter, not the v1
provider bridge. Compose it with `createSandboxPorts` from `sandbox-port-kit`
for CAS-backed Memory Store sync, output publication and gateway substitutions.
The existing Node `SANDBOX_PROVIDER=opensandbox` selection is **not switched**
to this adapter yet: its composition must supply the network enforcement port
below and use the v2 storage implementation, rather than claim native mounts.

Required configuration:

- `options.runtime`: explicitly `docker`, `kubernetes`, or `fast`; this declares
  the actual server backend, it does not switch the remote server's backend.
- `deploymentId`: stable, non-secret, unique to the configured endpoint/account.
  Handles and refs carry it along with backend and workspace/session ownership;
  switching any of these rejects old references before accessing the provider.
- `network`: a deployment implementation of `OpenSandboxNetworkPort`.
  `prepare` must arrange enforcement before allocation and return the SDK's
  creation-time domain policy. `replace` must replace the whole effective
  policy, including removal of old grants, CIDRs and platform hard denies.
  The SDK's domain-only `patchEgressRules` is **not sufficient**. There is no
  default or boolean bypass. The deployment implementation and direct-egress
  isolation require live certification; unit doubles do not establish security.
- `gateway` and optional `channels`: the hosts/IPs needed by the platform.
- Fast only: `fastBase: { image, templateId }` binds the exact selected image to
  a prebuilt Fast template. A different image is rejected, not ignored.

### Credential injection selection

The v2 adapter factory accepts `credentialInjection: "gateway" | "provider"`.
Omitted means `gateway`: no native egress factory is supplied, and the existing
configuration SDK composes its forwarder. `provider` supplies `native.egress`,
enables `credentialProxy` at sandbox creation (including snapshot restores),
and requires `deps.egress.secrets.read`. Fast rejects provider mode immediately.
This is a TypeScript composition option, not a new environment variable or a
change to the current Node default provider wiring.

Provider mode explicitly gives the OpenSandbox credential proxy custody of
plaintext credentials. OpenMA sends them only through the provider Vault API;
sandbox environment variables contain placeholders, not secrets. Bindings use
HTTPS-only host matching and passthrough substitution on exactly the requested
header/body surfaces, not automatic Authorization/header injection. Network
policy is still enforced separately.

Attach/update delete the previous Vault before replacing the complete policy
and credential set. A brief unavailable-credential window is intentional: old
bindings must not survive a narrowing or removal. Updates reread credentials,
including rotations with unchanged IDs. Revoke deletes the Vault and clears
tracked placeholder environment values. Operations on one runtime are serialized
so an in-flight attach cannot overtake revocation. SDK error payloads are not
propagated because they can contain plaintext. A failed cleanup propagates;
the host must destroy the sandbox, not snapshot or reuse it. Lifecycle snapshot
and template creation also revoke provider credentials defensively before capture.
Handles record the injection mode; changing it requires new compute.

Current native-mode restrictions are explicit, never silent fallbacks:

- At most one substitution per policy. The SDK does not establish how multiple
  overlapping bindings compose; use gateway for multi-credential policies.
- Only credentials with `expiresAt: null`. Provider bindings have no TTL field;
  host timers cannot guarantee expiry after host loss. Use gateway for expiring
  credentials, including OAuth tokens with an expiration timestamp.
- Provider custody does not provide a remote execution-lease fence. Host crash
  can leave a Vault active until cleanup or sandbox expiry. Select gateway when
  credentials must be checked against current execution authority per request.
- Real Docker/sidecar HTTPS trust, substitution and teardown remain to be
  certified. Real-SDK serialization tests do not prove live MITM behavior.

### Persistence and handles

All backends declare `handle: "changes"`. Attach may retain an existing ID;
restoring a snapshot allocates a new ID that the Session core must persist
under its fence. `maxLifetimeMs: null` describes a renewable absolute lease,
not indefinite data retention. The lease must exceed the plan's idle window.

Pause first waits for a **Ready snapshot**, then pauses the original runtime.
The original handle remains usable until provider TTL expiry; the separate
snapshot is the fallback after attach returns `gone`. Docker/Fast pause can
retain memory; Kubernetes pause is filesystem-only. Do not rely on portable
snapshots preserving processes across every backend. Fast snapshots may retain
processes: quiesce ACP and revoke egress before snapshotting. Images must include
Node and the executables required by generic file sync and relay installation.

Snapshots are not Memory Store or output mounts. Generic storage copies those
in and writes them back under CAS/fencing; it is not continuous shared storage.
Static deployment volumes are rejected in v2 to prevent shared host/PVC paths
crossing Session boundaries. Templates are snapshot refs reusable within one
workspace, not across workspaces. `discard` deletes snapshots, while `release`
deletes compute by serialized handle. Provider throttling maps to retryable
errors, missing compute to `gone`, and snapshot failure never stops compute.

Residual lifecycle limits: an interrupted snapshot/pause or a crash before the
host publishes its ref can leave an unreferenced snapshot; deployment snapshot
GC is still required. Retaining the paused handle narrows but does not eliminate
the crash window: if ref publication fails and that handle later expires, the
host cannot recover an unrecorded ref. Snapshot retention/deletion behavior and
restore-time policy enforcement must be certified on the selected backend.
The adapter is opt-in pending that deployment integration and live validation.

## Lifecycle mapping

OpenSandbox pause does **not** freeze `expires_at`: expiry stays absolute
while a sandbox is paused, and the server expires the runtime at that deadline. Fast Sandbox can retain a `Terminated` record until it is explicitly deleted. Pause is for
hot reclaim inside the TTL window. Long-lived files belong in volumes,
external services or explicit snapshots, never in long pause plus renew.

| OpenMA strategy | OpenSandbox primitive | Lifetime | Verification |
| --- | --- | --- | --- |
| `retained_runtime` + `suspend`/`resume` | `Sandbox.pause` / `Sandbox.resume` (same sandbox id) | Hot only, within `expires_at` | Docker and Fast (Kubernetes): live-certified |
| `durable_mount` | `volumes` on `Sandbox.create` (`pvc` / `ossfs` / `host`) | As durable as the backing volume | Mock-tested only; live-untested |
| `checkpoint_restore` | `SandboxManager.createSnapshot` → `Sandbox.create({ snapshotId })` (new sandbox) | Portable, until the snapshot is deleted | Docker and Fast (Kubernetes): live-certified |

What a `retained_runtime` pause keeps depends on the backend, so declare it
with `OPENSANDBOX_RUNTIME`. Without a declaration the adapter advertises only
`suspend: ["filesystem"]`, and `suspend({ kind: "memory" })` throws.

| `OPENSANDBOX_RUNTIME` | Pause mechanism | Retains | Status |
| --- | --- | --- | --- |
| `docker` | Container freeze | Files, memory and running processes | Live-verified (process and counter survive pause/resume) |
| `fast` | rootfs + vmstate + guest memory checkpoint | Files, memory and running processes | Kubernetes live-tested with template-backed create, pause/resume and snapshot restore through patched HA ingress |
| `kubernetes` (BatchSandbox) | rootfs committed to an OCI image | Files only: no processes or memory (QEMU VMState is an opt-in upstream exception, not assumed). Re-inject credential/egress state after resume. | Untested |

Hooks map to the official SDK only:

- `suspend({ kind })` renews the expiration to `OPENSANDBOX_TIMEOUT_SECONDS`
  (the normal active window) and then calls `Sandbox.pause()`. If renewal fails
  it does not pause. There is no separate long suspended TTL: a paused runtime
  expires one active window after suspend unless the host resumes it. Waits for `Paused` before returning a `runtime`-scoped handle for the same sandbox id; asynchronous `Pausing` is bounded by `OPENSANDBOX_READY_TIMEOUT_MS`.
- `resume(handle)` → `Sandbox.resume()` (fresh execd endpoint), then renews
  to `OPENSANDBOX_TIMEOUT_SECONDS`. No-op when already running.
  `sandboxProvider.resume` resumes a paused runtime when attaching by handle.
  Fast Sandbox renews before resuming: renewal changes the Kubernetes generation and can temporarily revoke route readiness, so the SDK readiness check must run after both updates. A failed renewal leaves the runtime paused.
- `checkpoint({ kind: "filesystem", name })` → `SandboxManager.createSnapshot`,
  polled until `Ready` (`OPENSANDBOX_SNAPSHOT_TIMEOUT_MS`, default 600000;
  `OPENSANDBOX_SNAPSHOT_POLL_MS`, default 1000). Returns a `portable` handle.
  The portable handle uses kind `filesystem`, meaning files are preserved. Fast Sandbox snapshots also retain guest memory and processes; Docker/container filesystem snapshots do not. Portable handles of kind `memory` are refused.
  On Fast Sandbox, the adapter also waits for source execd readiness before returning the checkpoint, so the next operation does not race snapshot recovery.
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
(files and, on declared Docker/Fast backends, a running process survive), hot pause
within the active window, resume-by-handle of a paused runtime,
and filesystem snapshot + restore into a new sandbox, configure the connection
variables above and run:

```sh
pnpm --filter @open-managed-agents/sandbox-adapter-opensandbox test:certification
```

For the #566 long-idle regression (310 seconds, no model required):

```sh
# Real HTTP relay + child on the local host; no OpenSandbox server needed.
OMA_STDIO_LONG_TEST=1 pnpm --filter @open-managed-agents/sandbox-adapter-opensandbox test
# Actual remote OpenSandbox lifecycle (connection variables required).
OMA_OPENSANDBOX_LONG_CERTIFICATION=1 pnpm --filter @open-managed-agents/sandbox-adapter-opensandbox test
```

The local relay check does not certify OpenSandbox gateway timeouts or a full
ACP/model/Execution run. Run the remote check and the issue's real-session
scenario before claiming deployment acceptance.

The live checks create temporary remote sandboxes and one snapshot, and delete
them in cleanup. The snapshot check needs a server runtime with snapshot support.
