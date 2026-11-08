# ADR 0016: The workspace root comes from the image; platform files live outside it

**Status**: Proposed (2026-11-06)
**Owner**: @hrhrng
**Tracking**: [#537](https://github.com/openma-ai/open-managed-agents/issues/537)
**Supersedes**: None
**Related**: [`0005-self-hosted-worker-runtime-resources.md`](0005-self-hosted-worker-runtime-resources.md),
[`0014-session-sandbox-provisioning-and-tool-wall.md`](0014-session-sandbox-provisioning-and-tool-wall.md),
[#531](https://github.com/openma-ai/open-managed-agents/issues/531) (Harbor task format)

---

## Context

`/workspace` is a literal, not a setting. It appears 305 times in 81 source
files under `packages/` and `apps/`, and it means two different things:

- **Where the agent works.** Harness tools default to it
  (`apps/agent/src/harness/tools.ts`, glob/grep), provider adapters run every
  command there (`packages/sandbox-adapter-opensandbox/src/opensandbox.ts`,
  `run()`; the same in daytona, e2b, modal, vercel, boxlite, litebox,
  cloudflare-bridge), and ACP agents start there
  (`packages/harness-runtime-acp/src/node-supervisor.ts`, `cwd`).
- **Where the platform keeps its own files.** Skills
  (`/workspace/.openma/skills/…`, `packages/control-plane-node/src/lib/node-managed-session-inputs.ts`
  and `node-supervisor.ts` `materializeSkills`), the ACP instructions file
  (`/workspace/AGENTS.md`, `node-supervisor.ts`), ACP native state
  (`/workspace/.openma/harness-state/…`, `packages/acp-runtime/src/native-state.ts`),
  language environments (`/workspace/.venv`, `packages/sandbox/src/environment-packages.ts`)
  and the checkpoint/backup scope (`tar -C /workspace`,
  `packages/control-plane-node/src/lib/node-managed-workspace-checkpoints.ts`).

This breaks images that already define where work happens. Harbor tasks
(#531) set `WORKDIR` and expect the agent and the verifier there; in
terminal-bench@2.0 all 89 images set it (86 `/app`, plus `/app/personal-site`,
`/app/dclm`, `/workspace`). Observed on a real run: the agent started in an
empty `/workspace` and had to `find /` before it reached the task repository.
Pointing `/workspace` at `/app` is not enough either: `AGENTS.md` and
`.openma/` would land inside the task's own tree (an untracked file in a git
task, a different directory listing than Harbor shows).

Harbor separates the two. Platform paths are fixed absolute roots outside
the task (`/logs/agent`, `/logs/verifier`, `/tests`, `/solution`,
`/installed-agent`), agent homes are redirected out of the task
(`CLAUDE_CONFIG_DIR=/logs/agent/sessions`, `CODEX_HOME=/tmp/codex-home`), and
each installed agent copies skills into the location it natively discovers
(`$CLAUDE_CONFIG_DIR/skills/`, `$HOME/.agents/skills/`); nothing is written
into `WORKDIR`.

## Decision

1. **The workspace root is a per-sandbox value.** It must be resolved once
   when the sandbox is created and carried with it; nothing may hard-code
   `/workspace` as the place the agent works.
   - It must be the image's `WORKDIR` when the image declares one.
   - It must be `/workspace` when the image declares none (Docker's own
     default `/` is rejected: the workspace root is also the checkpoint
     scope).
   - The provider adapter owns the resolution (registry config for image
     references, the provider's template metadata or a first-exec probe
     otherwise) and must fail sandbox creation if it cannot resolve it,
     rather than guess.
2. **Commands, tools and ACP agents start in the workspace root.**
3. **Platform files must not be written under the workspace root.** They
   live under a fixed root `/oma/`: skills in `/oma/skills/<id>/<version>/`,
   harness state in `/oma/harness-state/…`. `/mnt/session/outputs` and
   `/mnt/memory` are unchanged.
4. **Skills are registered the way each harness discovers them natively.**
   An ACP harness links or copies `/oma/skills` into its own skills location
   (Claude Code `$CLAUDE_CONFIG_DIR/skills/`, Codex `$HOME/.agents/skills/`);
   the in-process harness keeps naming the `/oma/skills` paths in its prompt.
   Agent homes are redirected under `/oma/` so they stay out of the task.
5. **The system prompt is passed through the harness's own channel**, not by
   writing `AGENTS.md` into the workspace.
6. **Checkpoint, backup and restore cover the workspace root**, plus
   `/oma/harness-state` (ACP native sessions must survive a host change).
   Other platform files under `/oma/` are re-materialized on every start.
   A checkpoint records the root it was taken at; restoring into a different
   root fails.
7. **Harbor evaluation rejects images without `WORKDIR`** with
   `UnsupportedHarborTaskError`: Harbor would run them in `/` and the platform
   in `/workspace`, so scores would not be comparable. (No terminal-bench@2.0
   task is affected.)

## Consequences

- Harbor tasks and any image built around its own `WORKDIR` behave as they
  do under `docker exec`; the task tree is exactly what the image ships.
- Existing images without `WORKDIR` keep `/workspace`. Images that do set
  `WORKDIR` change behaviour: the agent starts there and checkpoints cover
  it instead of `/workspace`. This is observable and needs a release note.
- Every provider adapter must report the workspace root; the provider
  conformance suite (`packages/managed-runtime-host/src/provider-conformance.ts`)
  must assert it, including the no-`WORKDIR` default.
- Per-harness skill registration is code per ACP agent, the same cost Harbor
  pays per installed agent.
- Checkpoints taken before this change are rooted at `/workspace`; restoring
  one into a sandbox whose root differs must fail explicitly, not silently
  restore elsewhere.

## Alternatives considered

- **Keep `/workspace` and `cd` / symlink to `WORKDIR` for Harbor only.**
  Leaves platform files in the task tree and makes evaluation differ from
  production behaviour.
- **An explicit Environment field (`_oma.workspace_dir`).** Predictable, but
  every image author would restate what the image already declares; the
  image is the source of truth.
- **Use Docker's default `/` when `WORKDIR` is unset.** Matches Docker, but
  makes the whole filesystem the checkpoint scope.

## Open questions

- How each supported ACP agent accepts a system prompt without a file in the
  working directory (claude-agent-acp, codex-acp, others in the registry).
- How template-based providers (e2b templates, daytona snapshots, sprites)
  expose the image's working directory, or whether a first-exec probe is
  the only portable answer.
- Whether `/oma/` must be writable by a non-root image `USER`.

## Rollout

1. Sandbox port carries the workspace root; OpenSandbox adapter resolves it
   from image config; conformance test for both branches. Verified by a
   terminal-bench task whose `WORKDIR` is `/app` and an image without one.
2. Harness tools, ACP `cwd` and provider `run()` use it.
3. Move skills, harness state and agent homes to `/oma/`; per-harness skill
   registration; drop `/workspace/AGENTS.md`. Verified by a real Claude Code and
   Codex ACP session that loads a managed skill.
4. Checkpoint/backup scope follows the root; explicit failure on a root
   mismatch.
5. Remaining adapters; Harbor runner rejects images without `WORKDIR`.
   Re-run the terminal-bench baseline and compare with the pre-change run.

## Implementation status (2026-11-06)

Done in the #531 worktree:

- `SandboxPort.resolveWorkspaceRoot?()` / `workspaceRootOf()` with
  `DEFAULT_WORKSPACE_ROOT` and `PLATFORM_ROOT` (`packages/sandbox/src/ports.ts`).
- OpenSandbox resolves the root with a cwd-less `pwd` on create and resume
  (`/` → `/workspace`, invalid output fails), runs every command there and
  creates the root and `/oma`.
- Pi harness glob/grep default to the root; web_fetch cache in `/oma/web`;
  skills in `/oma/skills/<id>/<version>`.
- acp-sandbox: ACP `cwd` is the root, native state in `/oma/harness-state`,
  no `AGENTS.md`: the system prompt is prefixed to the first prompt of a new
  ACP session (and to a recovery prompt).
- Node checkpoints archive the root and, when non-empty,
  `/oma/harness-state` as a second blob; metadata
  `openma.workspace.root.v1` records the root (absent = legacy
  `/workspace`), a mismatch fails restore. Legacy backups, repository
  resource paths and the restart notice follow the root.
- Harbor `requireAgentWorkdir` refuses images without WORKDIR; the agent
  runner checks the session's `pwd` equals the image WORKDIR before grading.

Deferred:

- Environment Work supervisor (`packages/harness-runtime-acp/src/node-supervisor.ts`):
  it may run on the host and maps only the protocol path `/workspace`;
  it still writes `/workspace/AGENTS.md` and `/workspace/.openma/skills`.
  `WorkspaceBinding.mountPath` stays the protocol path `/workspace`.
- Other adapters (daytona, e2b, modal, vercel, boxlite, litebox,
  cloudflare-bridge) and the Cloudflare runtime do not resolve a root and keep
  `/workspace`; the conformance suite does not assert it yet.
- Per-harness native skill registration and claude-acp `_meta.systemPrompt`.
- Environment packages (`.venv`, `.npm-global`, …) stay under `/workspace`;
  under another root they are not checkpointed and are reinstalled after a
  restore.
