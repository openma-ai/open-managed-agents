# ADR 0014: Provision the Session sandbox at create time; wall tools, not the model

**Status**: Proposed (2026-11-02)
**Owner**: @hrhrng
**Tracking**: [#390](https://github.com/openma-ai/open-managed-agents/issues/390)
**Supersedes**: None
**Related**: [`0005-self-hosted-worker-runtime-resources.md`](0005-self-hosted-worker-runtime-resources.md),
[`0006-session-execution-authority.md`](0006-session-execution-authority.md),
[`0008-provider-environment-worker-installations.md`](0008-provider-environment-worker-installations.md),
PR [#362](https://github.com/openma-ai/open-managed-agents/pull/362) (Pi background sandbox),
PR [#373](https://github.com/openma-ai/open-managed-agents/pull/373) (OpenSandbox lifecycle),
research gist [hrhrng/d626f288…](https://gist.github.com/hrhrng/d626f2884e9cda6e47789fca931c0af1)

---

## Context

The harness runs outside the sandbox. Only sandbox-backed tools (shell, file
operations, anything that reads `/workspace`) need a live, prepared sandbox.
Today the model waits for the sandbox anyway.

Current behaviour on `main`:

- **Session create does not start a sandbox.**
  - Node: `main-node` always wires a Session Execution worker, so
    `NodeManagedSessionRuntimeAdapter.sessionStarted` returns without calling
    the driver (`packages/control-plane-node/src/lib/node-managed-session-runtime.ts`,
    `NodeManagedSessionRuntimeAdapter`; wiring in
    `packages/control-plane-node/src/modules/node-managed.ts`).
  - Cloudflare: `PUT /init` on the SessionDO deliberately skips warmup —
    `ctx.waitUntil(warmUpSandbox())` "dies on DO reset", so the first user
    message pays the cold start (`apps/agent/src/runtime/session-do.ts`,
    comment after `bootstrap_execution`).
  - `self_hosted` environments are routed to Environment Work at create
    (`packages/managed-agents-adapters-runtime/src/session-lifecycle-router.ts`);
    the worker owns its lifecycle. Out of scope here.
- **The first turn blocks on the sandbox before the harness runs.**
  - Node: accepting a batch calls `start()` (three attempts, exponential
    backoff, `status_rescheduled` while retrying) and only then
    `runner.accept()` (`node-managed-session-runtime.ts`).
  - Cloudflare: warmup is kicked off early but awaited before harness and
    tool construction, on purpose: "closes the first-turn race where files,
    repositories or skills were absent from the model's initial capability
    snapshot".
- **Warm reuse probes synchronously.** Before reusing a sandbox, Node's
  `start()` calls `isSandboxCurrent` and `probe()` on every turn
  (`node-managed-session-runner.ts`, `start`). ADR 0005 recovery
  (`replaceLostSandbox`) already handles a sandbox that disappears mid-turn.
- **A no-sandbox mode already exists, but only on the OpenAI Agents surface.**
  `SessionSandboxMode = "none" | "sandbox"`
  (`packages/session-runtime/src/session-sandbox.ts`) resolves to `none` only
  when the session's OpenAI Agents mapping says `environment.type: "none"`
  (`packages/openai-agents-compat/src/session-mapping.ts`).
- **Node releases a sandbox only on archive/delete.** `StopSessionExecution`
  carries `reason: "archived" | "deleted"`
  (`packages/session-runtime-contract/src/lifecycle.ts`); otherwise reclaim is
  left to provider lifetime/lease expiry.
- **PR #362** (open) makes Node start the sandbox in the background and gates
  the three executor primitives behind `ensureSandbox()`, but only for the Pi
  harness, only without `checkpoint_restore`, and still at turn time — not at
  create.

Claude Managed Agents provisions when the session is created and blocks
sandbox tools, not model output, while it is not ready. That is the model this
ADR adopts (details in the research gist).

## Decision

### 1. Provisioning starts at Session create

For a Session whose execution authority is `session_execution` and whose
sandbox mode is `sandbox`, creating the Session must start sandbox
acquisition **and** preparation (resources, skills, environment packages,
workspace restore). The create response must not wait for it.

The start must be durable: it is driven by the same mechanism that drives
turns (ADR 0006 Session Execution on Node, the DO alarm/execution queue on
Cloudflare), never by a fire-and-forget promise or `waitUntil`. A replica or
DO reset loses no more than a turn would.

### 2. The wall is on sandbox tools, not on the harness

- A turn must be able to start, call the model and stream text while the
  sandbox is not ready.
- Every sandbox-backed operation must go through one readiness barrier. It
  awaits "prepared" (not merely "container up"), retries acquisition on
  failure, and has a bounded wait. On timeout or exhausted retries the
  operation fails as a **tool error** in the turn, not as a turn-level
  `session.error`.
- Tools that do not touch the sandbox (custom tools, MCP tools,
  `call_agent_*`, and any host-side tool) must not wait on the barrier. Each
  built-in tool declares whether it is sandbox-backed; the runtime must not
  guess.
- Post-turn work that needs the sandbox (memory/output sync, checkpoint
  publish) runs only if the sandbox became ready during the turn
  (as in #362's `sandboxReady`).

### 3. The first-turn capability snapshot comes from configuration

The tool list and the system prompt of a turn must be derivable from the
agent version, session resources and environment config alone. They must not
depend on probing a prepared sandbox. This replaces the reason Cloudflare
awaits warmup today: the model sees mount paths, skills and repositories
because they are declared, and the barrier guarantees they are present before
the first tool that reads them runs.

### 4. Resume does not probe on the turn path

Reusing a warm sandbox must not synchronously probe before the model starts.
Liveness is checked at the barrier (first sandbox operation of the turn); a
lost sandbox goes through ADR 0005 recovery.

### 5. Modes and authorities are unchanged

- `none` sessions (OpenAI Agents `environment.type: "none"`) provision
  nothing and have no wall. Native `/v1` sessions remain sandboxed; this ADR
  does not add a native `none`.
- A Session's sandbox mode does not change after create.
- `self_hosted` / Environment Work keeps its current behaviour.

## Consequences

- First text arrives without cold-start latency; the first sandbox tool waits
  at most the remaining provisioning time instead of the whole of it.
- A Session that is created and never used now holds a sandbox. Node
  currently has no idle reclaim before archive/delete, so this needs an
  explicit unused-provision TTL (open question 3) or the cost lands on
  provider lifetime limits.
- Provisioning failures surface later and in a different place: as a tool
  error inside a turn rather than as `status_rescheduled` before it. Clients
  that treat `rescheduled` as "sandbox starting" must be told (docs + SDK).
- Tool definitions must become config-derived on Cloudflare; any tool or
  prompt fragment that today reads the prepared sandbox has to move.
- Tests must cover: text-only turn with a never-ready sandbox; tool call
  during provisioning; provisioning failure then success on retry; DO/replica
  reset during create-time provisioning; resume after provider reclaim.

## Alternatives considered

- **Keep lazy provisioning at first accept (status quo).** Every first turn
  pays the full cold start, text included.
- **Overlap at accept only (PR #362 generalized).** Hides the cold start
  behind the first model call but still starts late; kept as rollout step 1,
  not the end state.
- **Fire-and-forget warmup at create.** Already rejected on Cloudflare: it
  dies on DO reset.
- **Block create until the sandbox is ready.** Moves the cold start into the
  create call; clients that create then immediately send see no gain.
- **Make native sessions `none` by default and provision on first tool.**
  Changes `/v1` semantics and still pays the cold start at the first tool.

## Open questions

1. **Where does the Node sandbox live?** The runner keeps sandboxes in
   process memory, and the Session Execution lease can land on any replica.
   Does create-time provisioning admit a dedicated execution under ADR 0006,
   and how does the next turn find that replica (affinity, or a sandbox
   handle reattachable from any replica)?
2. **`checkpoint_restore` needs an execution fence.** Restoring the workspace
   requires a Session Execution fence (`acquireSandbox`). Does create-time
   provisioning take a provisioning fence, or does it only acquire the
   container and defer `materialize`/`attach` to the first turn?
3. **Unused-provision TTL.** Default value, and whether it is per
   environment.
4. **Status projection.** Should `session.status_rescheduled` be emitted when
   a tool is actually blocked on the wall, or never during a running turn?
5. **Barrier timeout.** Default bound, and whether the model gets a hint
   ("sandbox still starting, retry") instead of a plain error.

## Rollout

1. Generalize #362's barrier on Node to all harnesses (not only Pi), keeping
   accept-time start. Verify with the tests listed above.
2. Cloudflare: make tool definitions config-derived, then replace the
   pre-harness `await warmUpSandbox()` with the barrier.
3. Remove the synchronous reuse probe from the turn path on Node.
4. Move the start to Session create on both runtimes, after open questions
   1–3 are answered.
5. Document the behaviour in `docs/` and the SDK; fold the research matrices
   from the gist into `docs/` as reference, not into this ADR.
