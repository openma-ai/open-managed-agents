# OpenSandbox adapter

Native [OpenSandbox lifecycle](https://github.com/opensandbox-group/OpenSandbox/blob/main/specs/sandbox-lifecycle.yml)
and [execd](https://github.com/opensandbox-group/OpenSandbox/blob/main/specs/execd-api.yaml)
HTTP implementation of OpenMA's `SandboxProviderPort` and `SandboxFactory`.
The package is private and needs no provider SDK installation.

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
| `OPENSANDBOX_BASE_URL` | derived from protocol/domain + `/v1` | OpenMA override for the complete lifecycle API base URL, e.g. `https://sandbox.example.com/v1`. Takes precedence over domain/protocol. Include any reverse-proxy prefix and `/v1`. |
| `OPENSANDBOX_TIMEOUT_SECONDS` | `1800` | Initial sandbox lifetime, integer seconds, minimum `60`. OpenMA renews active runtime leases via `renew-expiration`. |
| `OPENSANDBOX_READY_TIMEOUT_MS` | `120000` | Provisioning and execd readiness deadline in milliseconds. |
| `OPENSANDBOX_CPU` | `1` | OpenSandbox `resourceLimits.cpu` quantity. |
| `OPENSANDBOX_MEMORY` | `1Gi` | OpenSandbox `resourceLimits.memory` quantity. |
| `SANDBOX_IMAGE` | `node:22-slim` | Prebuilt container image. Must provide Node.js, `sh`, `tail`, and any selected harness/runtime executables. |

The domain/key names follow Harbor. Base URL, resource, and timeout variables
are OpenMA adapter configuration, mapped to the upstream OpenAPI fields.
The OpenMA host must reach endpoints returned by the server for execd (44772)
and stdio relays (random ports 45000–64999). Configure Docker host addressing or the
OpenSandbox gateway accordingly; endpoint response headers are honored.

Commands run in `/workspace`; relative file paths are rooted there. Files are
binary safe. `sandboxProvider.resume` attaches an existing running runtime by
its persisted handle. Creation waits for Running and execd `/ping`; failed
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
`workspace: { strategies: ["ephemeral"] }`. Select an image containing the
OpenMA runtime and supply the usual runtime environment verification and
harness configuration. The default Node image supports basic sandbox tools;
it does not preinstall an OpenMA worker.

Pause/checkpoint/portable restore, native background process handles, durable
workspace or memory mounts, and credential-vault/egress enforcement are not
advertised by this adapter. OpenSandbox Credential Vault policies require a
separate, explicit mapping to OpenMA's credential egress port; no enforcement
is inferred from provider selection.

Run the default tests without an OpenSandbox server:

```sh
pnpm --filter @open-managed-agents/sandbox-adapter-opensandbox test
pnpm --filter @open-managed-agents/sandbox-adapter-opensandbox typecheck
```
