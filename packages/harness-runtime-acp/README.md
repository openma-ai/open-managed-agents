# @open-managed-agents/harness-runtime-acp

Provider-neutral whole-brain ACP harness for the `openma_supervised` Runtime
Host lane.

The package runs the Session command stream, ACP child process, native Session
state hooks, semantic recovery, and Session event sink inside the sandbox. It
does not claim Environment Work, acquire compute, publish workspace/output
candidates, or implement durable storage. Those authorities remain outside the
sandbox in `@open-managed-agents/managed-runtime-host`.

## Versioned harness releases

The environment image supplies Node, npm and `openma-acp-supervisor`. Harness
software is prepared after sandbox allocation, independently of that image.
Select a published release in the existing Runtime Profile:

```ts
const driver = {
  type: "openma_supervised",
  protocol: "openma-harness-supervisor-v1",
  supervisor: { command: "openma-acp-supervisor" },
  harness: { id: "codex-acp", version: "1.8.0" },
  readyTimeoutMs: 660_000, // allow first-install time before ready
  heartbeatTimeoutMs: 30_000,
  drainTimeoutMs: 5_000,
};
```

`codex-acp` resolves to `@agentclientprotocol/codex-acp` by default. Other
published selections resolve through the official ACP Registry, including its
history for older versions. The shared `@openma/common/acp-artifacts` layer
selects a compatible binary, npx or uvx distribution and verifies its release
identity and artifact integrity before making it launchable. There is no
fallback to another version or a PATH executable when preparation fails.

Operators can replace the default registry/catalog with `OPENMA_ACP_SOURCES`:

```json
{
  "codex-acp": { "type": "npm", "package": "@agentclientprotocol/codex-acp" },
  "python-agent": { "type": "uvx", "package": "python-agent", "command": "agent", "python": "3.12" },
  "goose": { "type": "registry" },
  "custom": { "type": "registry", "manifestUrl": "https://releases.example/{version}/agent.json" }
}
```

The explicit catalog is an allowlist; `{}` disables all published releases.
`OPENMA_ACP_PACKAGES` remains an alias for existing npm package-string catalogs,
and cannot be combined with `OPENMA_ACP_SOURCES`. Release versions belong to
the published metadata, not the catalog. Registry sources optionally specify
`preference: ["uvx", "npx", "binary"]`; the default is binary → npx → uvx.
Registry arguments and environment are preserved, with Work credentials scrubbed
before the ACP child starts. Custom manifest URLs accept `{id}` and `{version}`
placeholders and must return an ACP manifest with the matching identity.

Binary preparation supports raw executables, zip, tar, tar.gz/tgz, tar.bz2/tbz2,
and tar.xz/txz. It validates paths and checksums before publishing an executable.
If an old Registry entry omits its checksum, the first HTTPS download's content
hash is pinned in the Session record. uvx uses an isolated, relocatable virtual
environment with the selected PyPI release's hashes. Both console entry points
and wheel-packaged executables are supported.

The supervisor validates Work scope and credentials before preparation. It
persists the resolved manifest under
`/workspace/.openma/harness-releases/<session-id>.json`, so workspace snapshots
carry it to replacement sandboxes. Restores use that manifest without resolving
registry metadata again; native checkpoints also bind its digest. Changing a
Session's source, version or artifact is rejected: create a new Session.
Artifact cache defaults to `/tmp/openma-acp-artifacts`; set
`OPENMA_ACP_ARTIFACT_ROOT` to use another sandbox-local cache. It is partitioned
by platform and language runtime, and fully prepared artifacts work offline.

The environment needs npm for npm sources; uv and a compatible Python interpreter
for uvx; and bzip2/xz for those binary formats. Provision Python with
`uv python install` if needed. A cold sandbox needs registry/artifact network
access, and first preparation must fit within `readyTimeoutMs`. OS libraries
remain part of the environment. These preparation paths target POSIX sandboxes.
The digest pins the top-level artifact; identical transitive dependency trees
across independently prepared sandboxes need bundled or locked releases.

`openma-acp-work-item` uses the same path with `OPENMA_HARNESS_ID=codex-acp`
and `OPENMA_HARNESS_VERSION=1.8.0`. The supervisor protocol version is independent
of the harness release. The runner reads `ANTHROPIC_ENVIRONMENT_ID`,
`ANTHROPIC_SESSION_ID`, `ANTHROPIC_WORK_ID`, and `ANTHROPIC_WORK_SECRET` from
its outer worker. Installer subprocesses do not inherit these credentials.

## Existing preinstalled integrations

Existing operators may retain `OPENMA_ACP_HARNESSES`, a JSON inventory of
`{ id, version, command, args? }` with absolute executable paths. This mode
selects only installed entries; it cannot be combined with `OPENMA_ACP_SOURCES`, `OPENMA_ACP_PACKAGES`
or custom agent overrides. It is an operator declaration, not artifact
verification. Without an explicit catalog, legacy `version: "1"` still resolves
preinstalled agents; it does not pin their software version. New integrations
should select a published release as above.

Custom integrations may compose `createNodeManagedAcpSupervisorApp()` from
`@open-managed-agents/harness-runtime-acp/node-supervisor`. The Console does not
yet provide a selector for this Runtime Profile lane.

## Ownership boundary

```text
OpenMA Environment Worker / Runtime Host
├── Work lease and sessions_token
├── resource CAS/fencing
├── sandbox acquire / hard kill
├── workspace checkpoint publication
└── output manifest publication
       │ openma-harness-supervisor-v1
       ▼
Sandbox supervisor
└── @open-managed-agents/harness-runtime-acp
    ├── Session command loop
    ├── ACP initialize/new/resume/prompt/close
    ├── ephemeral native Agent root
    ├── allowlisted native-state capture/restore
    └── canonical Session event publication
```

Harbor is used only as a reference for each coding agent's native Session
artifact locations. OpenMA owns the checkpoint format, ordering, fencing,
retry, retention and deletion semantics.

## Recovery

The live native Agent root is isolated under `/tmp/openma-harness-state/`.
Checkpoint hooks copy only declared Session artifacts into
`/workspace/.openma/harness-state/`; credentials, config, caches and unrelated
home-directory files are excluded. A replacement sandbox restores the
workspace before ACP `session/resume`.

After each completed turn the supervisor first captures the native allowlist
and writes `last_completed_turn_id` into `acp-session.json`, then publishes the
canonical `session.status_idle`, and finally asks the outer Runtime Host to
snapshot workspace and outputs under the active resource fence. This ordering
keeps canonical output visible if the outer checkpoint fails. The replacement
runner derives the canonical completed-turn watermark from Managed Events and
accepts native resume only when the restored manifest carries the same marker.
It therefore detects the crash window between event publication and workspace
pointer CAS instead of silently resuming an older native transcript. A stale
generation cannot acknowledge or replace the canonical checkpoint.

If a required native artifact is missing, or the native completion watermark
does not equal the canonical watermark, the runner rejects resume. With a
configured semantic-recovery Port, it starts a new ACP Session and injects
exactly one bounded recovery request built from canonical Managed Events.
Completed tool results and attachment references may be included; tool inputs
are never replayed.

## Tests

`pnpm test:coverage` enforces 100% statement, branch, function and line
coverage. The Node Runtime Host Docker lane additionally tests a new container
restoring a prior native Codex Session, ACP resume, cache-usage projection,
output publication and zero leaked containers.

### Cloudflare live artifact certification

With Wrangler authenticated, Docker running, and a working Codex login at
`~/.codex/auth.json`, run from the repository root:

```sh
OMA_CLOUDFLARE_LIVE_CERTIFICATION=1 \
OMA_CLOUDFLARE_HARNESS_CERTIFICATION=1 \
pnpm --filter @open-managed-agents/managed-runtime-cloudflare exec vitest run \
  test/cloudflare.live.test.ts --config vitest.config.ts
```

To use an existing image without rebuilding and pushing it, set
`OMA_CLOUDFLARE_CERTIFICATION_IMAGE` to its fully qualified, pinned registry
reference (the default Dockerfile currently only wraps the published sandbox base).

This creates an isolated Cloudflare Worker/container, uploads the current bundled
probe at runtime, and prepares uv 0.10.9 (binary), Ruff 0.11.0 (uvx), and
codex-acp 1.8.0 (npm). It checks cached preparation without artifact network access,
a real model response, and a second response after restarting the ACP process
and resuming its native session. It also exercises the provider's persistence,
lease, outbound proxy, revocation and destruction checks. This tests Cloudflare
runtime → shared artifact preparation → ACP → model, not the hosted control-plane
API or the supervisor Work protocol. The Codex credential is copied only into the
temporary test container and removed in `finally`; the suite deletes its Worker
and container resources. Set `OMA_CLOUDFLARE_HARNESS_REPORT` to an absolute path to
save the non-secret result JSON. R2 checkpoint certification remains a separate
opt-in requiring the R2 fixture credentials.

### Pi custom tools over Core MCP (WIP)

The managed Pi Work supervisor uses an official-SDK stdio relay to the
 authenticated Core Streamable HTTP endpoint. Discovery uses the pinned Session
 definitions; each call captures the current host-admitted canonical turn and
 scoped sandbox capability. The relay does not retry ambiguous calls or own
 pending results. Native call IDs are observed through ACP, then bound to Core
 receipts by the existing atomic Work event projection. MCP request IDs and
 argument equality are not invocation identities.

Pi's sampling-only extension pauses after the ordinary tools in a mixed batch
finish. On resume it replaces receipt placeholders with admitted canonical
answers. It registers no tools. The legacy Pi custom registration is neutralized
in the managed native state directory to avoid double advertisement.

The explicit local official-process gate requires the complete official
`@openma/pi-acp@0.1.8` installation and a built relay bundle:

```sh
node_modules/.bin/esbuild packages/harness-runtime-acp/src/node-core-custom-mcp-cli.ts --bundle --platform=node --format=esm --target=node20 --outfile=packages/harness-runtime-acp/dist/node-core-custom-mcp-cli.js
OMA_PI_ACP_ENTRY=/absolute/official-install/node_modules/@openma/pi-acp/dist/bin.js node node_modules/vitest/vitest.mjs run --root apps/main-node --config vitest.mcp-native.config.ts
```

This gate uses deterministic model inference, actual official Pi/SDK processes,
separate HTTP and Work processes, and SQLite. Physical publication ports are
controlled fixtures; it does not certify provider persistence, CF hosting,
PG/MySQL, canonical cancellation, or other harnesses. Full lifecycle acceptance
remains open.

Running-turn user cancellation now cancels published Core custom receipts in
canonical Session admission's SQL transaction. An idle `requires_action`
interrupt remains a no-op; an already-admitted external answer is not erased.
Work/generation identity fences the cancellation. This is not MCP connection
cancellation, and it does not authorize replay of an uncertain request.
Subsequent-turn recovery after cancellation remains an open lifecycle gate.

Cancellation recovery uses canonical `agent.tool_result` errors, not an
inference from an interrupt notification or a cancelled receipt alone. The
SQL Session append transaction closes each eligible published Core custom
call together with receipt cancellation, under the Session revision and the
original Work generation. Idle `requires_action` interrupts remain no-ops;
already admitted external answers win. Pi's sampling adapter hydrates the
matched canonical result on the next turn, including after HTTP/Work restart.
It does not register another custom tool or replay the cancelled operation.

The opt-in official-process gates require the complete verified
`@openma/pi-acp@0.1.8` distribution, supplied as `OMA_PI_ACP_ENTRY` (its
`dist/bin.js` path). No package download or fake fallback occurs:

```sh
# From apps/main-node; real HTTP and Work child processes, SQLite authority.
node ../../node_modules/vitest/vitest.mjs run --config vitest.mcp-native.config.ts -t 'Core MCP cancel-recovery'
# From repository root; starts localhost:47891 forwarding to local Workerd/D1.
node test/fixtures/core-mcp-cf-native-driver.mjs
```

Both use deterministic native Messages fixtures, not paid model inference.
The CF gate proves official native discovery/call, original-ID publication,
and canonical cancellation through authenticated CF routes. Its dispatcher
holder is an explicit fixture, and it stops before physical finalization;
it does not certify hosted acquisition, CF restart recovery, or a provider.
The Node gate supplies controlled physical finalization ports. Neither gate
is a full harness-matrix or four-topology acceptance result.

Local CF recovery composition can be exercised with the retained official
`@openma/pi-acp@0.1.8` executable:

```sh
OMA_CF_RECOVERY=1 OMA_OAUTH_MCP_TEST_PORT=47895 \
OMA_PI_ACP_ENTRY=/path/to/@openma/pi-acp/dist/bin.js \
OMA_CF_NATIVE_TRACE=/tmp/cf-recovery.json \
node test/fixtures/core-mcp-cf-native-driver.mjs
```

Run from the repository root. This explicit gate starts a real native Work/Pi
process and local Workerd/D1 host. It checks canonical cancellation followed by
a later user input, a fresh Work process, production native storage copy-sync,
local R2 byte readback and one normal completion. Its physical host port uses
local filesystem I/O and an actual tar archive; it does **not** certify the
Cloudflare container owner, backup publication CAS, native mount, or provider
acquisition. The archive is a measured local artifact, not a published provider
checkpoint. No model inference service is called.

The Node opt-in native gate additionally accepts name filters `Core MCP takeover`
and `Core MCP crash-ack`. These test a reclaimed same-Work generation (including
old-bearer rejection), and host death after canonical publication commits but
before its HTTP acknowledgement, respectively. The latter does not establish
continuation after rollback of a pre-commit publication transaction.


`Core MCP crash-precommit-recovery` exercises host SIGKILL inside the SQLite
publication transaction, before commit. The production Node supervisor now
journals an outbound batch durably in `.oma/work-output/` before sending it.
After process restart it retransmits the exact batch before admitting more
model input. This private delivery journal is not a second canonical event log:
only the authenticated host transaction publishes events and binds receipts.
The journal contains no bearer credentials and is scoped to the exact Work,
Session, Environment, workspace, generation and holder. A different owner does
not inherit authority to replay it. Files are mode 0600; write/fsync/rename and
directory fsync precede HTTP publication. Persistence errors fail closed.

An exact already-committed replay may receive its acknowledgement under the
same live fence and canonical input root. Changed event bytes, receipt binding,
holder or generation are rejected. The journal is cleared only after the host
acknowledges the original event IDs. Recovery retransmits output, not the tool
operation. The targeted gates verify actual official Pi processes and a single
ordinary side effect across restart. They do not prove VM/disk loss recovery,
transfer of an uncommitted journal to a new generation, PG/MySQL authority, or
Cloudflare container checkpoint acquisition/CAS.

Native harnesses other than Pi currently reject OMA custom-tool definitions
before launch with `core_custom_lifecycle_unavailable`. This prevents silent
omission while their Core receipt association, pending sampling barrier and
recovery adapters are still unimplemented. It is an OMA integration limit,
not a statement that those upstream harnesses lack ACP or MCP. Ordinary
builtins and configured external MCP servers retain their existing paths.

Kimi 2.6.0 can execute discovered MCP tools even when their names are absent from
the first native model request. The explicit non-Pi Core lifecycle rejection is
about missing production coordination/recovery, not that advertisement shape.
See `apps/main-node/test/fixtures/KIMI-CORE-BEHAVIOR.md` for the scoped official
process plus canonical Core behavioral gate and its limits.

### Supported-backend receipt wiring

Core MCP receipts use the canonical Session/Work transaction on Node PostgreSQL,
Node MySQL and Cloudflare D1. Node PostgreSQL installs migration
`0035_custom_invocations.sql`. MySQL uses its native InnoDB receipt schema
(binary identity collations and a SHA-256 generated unique key), not translated
SQLite TEXT keys; startup verifies that schema. D1 retains its separate
`apps/main/migrations/0032_custom_invocations.sql` migration.

Publication, answer consumption and cancellation retain generation and exact
holder fences. Row locks precede fresh database-clock checks. Cancellation
commits the receipt and the correlated error result together; MCP disconnects
do not cancel a call. Core discovery and receipt creation revalidate the
canonical turn when concurrent ordinary-tool publication advances the Session.

Backend verification uses real PostgreSQL/MySQL authority tests and the
representative official Pi HTTP/Work lifecycle fixture with
`CORE_MCP_DATABASE_URL` and `OMA_PI_ACP_ENTRY`. This is deterministic local
model-fixture evidence, not hosted provider certification or all-harness
acceptance. Migration validation needs the ordinary schema-migration privileges
including MySQL connection-local temporary-table creation.
