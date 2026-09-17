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

`codex-acp` resolves to `@agentclientprotocol/codex-acp` by default. The shared
`@openma/common/acp-artifacts` layer reads the exact npm release, verifies its
published name/version, records its SHA-512 integrity, and installs it into a
manifest-digest-specific directory. Only a complete, verified install becomes
launchable. Tags/ranges, unavailable releases and failed installs never fall
back to another version or a PATH executable. No global npm install is used.

Operators can replace the package catalog with `OPENMA_ACP_PACKAGES`, for example:

```json
{"codex-acp":"@agentclientprotocol/codex-acp","my-harness":"@my-org/my-harness"}
```

This maps identities to package names only; each selected version must actually
exist in the published package metadata. An empty object disables all releases.
The package must expose an ACP executable (one bin, or one named after the
harness/package). This first release supports npm distribution on POSIX
sandboxes; binary-archive and Python/uv distributions are not yet supported.
Packages requiring additional launch arguments should expose an ACP wrapper.

The supervisor validates Work scope and credentials before preparation. It
persists the resolved manifest under
`/workspace/.openma/harness-releases/<session-id>.json`, so workspace snapshots
carry it to replacement sandboxes. Restores use that manifest without resolving
registry metadata again; native checkpoints also bind its digest. Changing a
Session's package, version or artifact is rejected: create a new Session.
Artifact cache defaults to `/tmp/openma-acp-artifacts`; set
`OPENMA_ACP_ARTIFACT_ROOT` to use another sandbox-local cache. Fully prepared
artifacts can be reused offline. A cold sandbox needs npm/artifact network access.

The digest pins the top-level package artifact. For identical transitive
packages across independently prepared sandboxes, publish bundled dependencies
or an npm shrinkwrap; npm otherwise resolves dependencies on first installation.
The installed cache retains its generated lockfile.

`openma-acp-work-item` uses the same path with `OPENMA_HARNESS_ID=codex-acp`
and `OPENMA_HARNESS_VERSION=1.8.0`. The supervisor protocol version is independent
of the harness release. The runner reads `ANTHROPIC_ENVIRONMENT_ID`,
`ANTHROPIC_SESSION_ID`, `ANTHROPIC_WORK_ID`, and `ANTHROPIC_WORK_SECRET` from
its outer worker. Package subprocesses do not inherit these credentials.

## Existing preinstalled integrations

Existing operators may retain `OPENMA_ACP_HARNESSES`, a JSON inventory of
`{ id, version, command, args? }` with absolute executable paths. This mode
selects only installed entries; it cannot be combined with `OPENMA_ACP_PACKAGES`
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
