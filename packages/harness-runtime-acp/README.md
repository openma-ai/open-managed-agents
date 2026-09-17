# @open-managed-agents/harness-runtime-acp

Provider-neutral whole-brain ACP harness for the `openma_supervised` Runtime
Host lane.

The package runs the Session command stream, ACP child process, native Session
state hooks, semantic recovery, and Session event sink inside the sandbox. It
does not claim Environment Work, acquire compute, publish workspace/output
candidates, or implement durable storage. Those authorities remain outside the
sandbox in `@open-managed-agents/managed-runtime-host`.

## Preinstalled runner

Install `@open-managed-agents/harness-runtime-acp` in a Node-capable runtime
image and use `openma-acp-supervisor` as the `openma_supervised` process. The
runner reads the official Environment Work scope and secret from
`ANTHROPIC_ENVIRONMENT_ID`, `ANTHROPIC_SESSION_ID`, `ANTHROPIC_WORK_ID`, and
`ANTHROPIC_WORK_SECRET`. The selected harness id is an installed ACP agent id
(for example `codex-acp` or `pi-acp`).

Applications that need a custom installed-agent resolver can compose the same
production path through `createNodeManagedAcpSupervisorApp()` from
`@open-managed-agents/harness-runtime-acp/node-supervisor`.

## Select an installed harness version

For versioned selection, bake `OPENMA_ACP_HARNESSES` into the runtime image.
It is a JSON inventory of the **installed** executables, separate from the
requested selection. Install each version at a stable absolute path:

```dockerfile
RUN npm install --prefix /opt/harnesses/codex-acp/1.8.0 @agentclientprotocol/codex-acp@1.8.0
ENV OPENMA_ACP_HARNESSES='[{"id":"codex-acp","version":"1.8.0","command":"/opt/harnesses/codex-acp/1.8.0/node_modules/.bin/codex-acp"}]'
```

Select that entry in the existing Runtime Profile:

```ts
const driver = {
  type: "openma_supervised",
  protocol: "openma-harness-supervisor-v1",
  supervisor: { command: "openma-acp-supervisor" },
  harness: { id: "codex-acp", version: "1.8.0" },
  readyTimeoutMs: 30_000,
  heartbeatTimeoutMs: 30_000,
  drainTimeoutMs: 5_000,
};
```

The `openma-acp-work-item` entry point instead accepts the same selection as
`OPENMA_HARNESS_ID=codex-acp` and `OPENMA_HARNESS_VERSION=1.8.0`.
The supervisor protocol remains `openma-harness-supervisor-v1`; its protocol
version is independent of the selected software version.

Multiple inventory entries may share an id when their versions differ. Each
entry takes `id`, `version`, an absolute `command`, and optional string `args`.
Selection matches both id and version exactly. Missing versions are rejected;
there is no download, automatic upgrade or fallback to a different executable.
An empty inventory disables all harnesses. Malformed or duplicate entries fail
at startup. Inventory selection cannot be combined with `agentId`,
`OPENMA_ACP_AGENT_ID` in the Work-item runner, or a custom `resolveAgent`.

The inventory is an operator declaration of image contents, not binary
attestation. Keep it tied to a pinned image and locked dependencies, including
the underlying Codex version; changing the executable behind a declared version
invalidates that declaration. Native Session checkpoints store the selected
harness id and version. Resuming a checkpoint from another version (or migrating
between legacy and versioned checkpoints) is rejected; create a new Session.

Without the inventory, existing `version: "1"` selections retain their legacy
registry behavior. That value does **not** pin the installed software release.
The Console does not currently provide a selector for this Runtime Profile lane.

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
