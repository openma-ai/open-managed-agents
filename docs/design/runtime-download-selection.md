# Runtime discovery, download, pairing and selection — design memo

Status: **Draft** (2026-11-04) · Branch `draft/runtime-download-selection`
Issues: [#449](https://github.com/openma-ai/open-managed-agents/issues/449) (Amp-style env+secrets overlay), [#415](https://github.com/openma-ai/open-managed-agents/issues/415) (Console product-surface gaps)
Related: [ADR 0005](../adr/0005-self-hosted-worker-runtime-resources.md), [v1-architecture](../v1-architecture.md), [archive/external-agent-runtime](../archive/external-agent-runtime.md)

**Question.** How do users discover, download, install and pair the local runtime, and how do they choose and configure a runtime from the Console and from the CLI?

**Owner decisions this memo follows.**

1. One machine is one **Runtime**. A Runtime is a peer API resource to Environment (`/v1/oma/runtimes`) and is never nested under it.
2. An **Environment** either provisions a sandbox or attaches to an existing Runtime.
3. An Amp `--amp-env`-style **env + secrets overlay**, configured in the Console, is injected into the host runner (its shell, MCP servers and plugins).

---

## 0. What already exists (so we don't build it twice)

| Piece | Where | What it does today |
|---|---|---|
| Runtime registry | `apps/main/src/routes/runtimes.ts`, D1 tables `runtimes`, `runtime_tokens`, `runtime_tenants`, `connect_runtime_codes` | One row per `(owner_user_id, machine_id)`. Status and heartbeat come from RuntimeRoom. |
| Browser pairing | `POST /v1/oma/runtimes/connect-runtime` → `POST /agents/runtime/exchange` | The CLI listens on a loopback port and opens `/connect-runtime?cb=…&state=…`. The user clicks **Allow**. The code (5 min, single use) is exchanged for a `sk_machine_*` token plus one `oma_*` key per workspace. |
| Daemon + service install | `packages/cli/src/bridge/*` (`oma bridge setup / status / refresh / agents refresh / uninstall / daemon`) | Installs a launchd, systemd `--user` or Windows Task Scheduler service. Detects ACP agents through the ACP registry and offers to install wrappers. |
| Relay | `packages/runtime-relay`, `RuntimeRoom` DO, `WS /agents/runtime/_attach` | Carries daemon ↔ harness frames, with tenant validation. |
| Agent → Runtime binding | `AgentConfig.runtime_binding { runtime_id, acp_agent_id, local_skill_blocklist }`, `harness: "acp-proxy"` | **Routing today is per agent, not per Environment.** |
| Bundle | `GET /agents/runtime/sessions/:sid/bundle` | Returns AGENTS.md, skills, proxied MCP URLs and `env` (from session `env` resources). The daemon merges `env` into the spawned ACP child's `process.env` (`session-manager.ts`). |
| CLI listing | `oma runtime list`, `oma runtime rm` | |
| Console | `/runtimes` (RuntimesList + "Connect machine" modal), `/connect-runtime` (ConnectRuntime approval page) | Environments could only be created as `cloud`; the hosting-type select was disabled. |
| Environment extension | `_oma.sandbox_image` on `/v1/environments`, stored inside the `managed_environments.document` JSON | Shows the pattern for OpenMA-only fields. They need no migration and stay invisible to CMA clients. |

**Gaps that block "discover → use":**

- **G1:** No way to pair a machine that has no browser (SSH box, VM, CI runner, container). The loopback callback needs a browser on the same host.
- **G2:** The Environment can't say "use machine X". Placement lives only on the Agent (`runtime_binding`).
- **G3:** There is no Environment-level overlay. Env vars only come from per-session `env` resources.
- **G4:** Distribution is `npx @openma/cli` only. There is no standalone binary, no versioned install script and no update channel.

---

## 1. Comparable products

| Product | Unit | Download / install | Pairing credential | Selection / routing | Env / secrets to the host |
|---|---|---|---|---|---|
| **GitHub Actions self-hosted runner** | Runner (one per process) | The UI shows per-OS download, extract and `./config.sh` commands. `./svc.sh install && ./svc.sh start` installs the service. | **Registration token**, valid 1 hour (`POST …/actions/runners/registration-token` returns `token, expires_at`). There is also JIT config for ephemeral runners. | Labels and runner groups. Jobs target labels. | Repo or org secrets go to the job, not to the runner config. |
| **Buildkite agent** | Agent | Package managers or install script. `buildkite-agent start`. | Long-lived **agent token** per cluster (expiry optional through the API). Registration returns a session token, and each job gets a job token. | Queues plus `--tags k=v`. A step runs only on agents that have all its tags. | Pipeline env plus agent hooks. |
| **Tailscale** | Device / node | OS packages, `tailscale up`. | Interactive login, **or an auth key**: one-off or reusable, ephemeral, pre-approved, tagged, valid 1–90 days. `tailscale up --auth-key=…` (`file:` form supported). A QR code of the login URL is available for headless devices. | Tags and ACLs. | n/a |
| **Amp runners** | Runner = `amp` process on your machine | Install the CLI. The Mac app's "Use This Mac as a Runner" toggle runs `amp --no-tui --runner-id <name>`. | `amp login` (browser). | **Thread location picker** on ampcode.com. `--executor runner:<id>` from the CLI. `--share` exposes the runner to the workspace under "Shared Runners". | **`--amp-env`** (off by default): the runner fetches per-thread **Secrets & Env Vars** and adds them to the thread's shell and stdio MCP servers. Precedence is personal > project > workspace > runner process env. Changes apply to the next thread, and MCP servers and plugins restart on change. |
| **Cursor self-hosted machines** | Worker (`agent worker start`) | `curl https://cursor.com/install -fsS \| bash`. | My Machines: `agent login` (browser) or a personal API key. Team Pools: a service-account `CURSOR_API_KEY`. | **Pools** (`--pool gpu`) are named routing targets. An admin can require self-hosted machines. | `environment.json` + snapshot for cloud agents. |
| **Devin** | Devin's Machine (per org / repo) | Hosted VM. The setup wizard installs dependencies and snapshots the result. | n/a (hosted) | Per-repo machine config. Snapshots are versioned. | Secrets dashboard. direnv for per-repo env. |
| **Claude Managed Agents (self-hosted)** | Environment (`config.type: self_hosted`) = work queue. A worker serves it. | `brew install anthropics/tap/ant`, a release tarball, or `go install`. Then `ant beta:worker poll --workdir …`. | **Environment key**, generated in the Console only (`ANTHROPIC_ENVIRONMENT_KEY` + `ANTHROPIC_ENVIRONMENT_ID`). | Session targets `environment_id`. The worker claims work. `work/stats.workers_polling` reports health. | Worker env. Memory stores sync to `/mnt/memory`. |

**What carries over to OpenMA:**

- **Two pairing modes are standard.** Interactive browser login is for laptops (Amp, Cursor, Tailscale). A short-lived, single-use token printed as one paste-able command is for headless machines (GitHub registration token, Tailscale one-off auth key). OpenMA already has the first. G1 is the second.
- **Short TTL, single use, one command.** GitHub uses 1 hour, and Tailscale one-off keys are revoked on use. The UI hands over one full command, not a token plus instructions.
- **Selection belongs where the work is placed.** Amp uses a thread location picker, Cursor a pool, CMA an `environment_id`. In OpenMA that place is the **Environment**. "Attach to Runtime" is our equivalent of CMA's self-hosted Environment, except the queue is one known machine rather than any worker.
- **Overlay precedence matters.** Amp's personal > project > workspace > process order maps to session `env` resources > Environment overlay > daemon process env.
- **Health is part of selection.** CMA's `workers_polling` and Amp hiding runners that serve no directories both point the same way. The Console picker should show online/offline, and later the detected agents.

Sources:

- GitHub: [adding runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/adding-self-hosted-runners), [REST registration-token / JIT](https://docs.github.com/en/rest/actions/self-hosted-runners), [svc.sh](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/configuring-the-self-hosted-runner-application-as-a-service)
- Buildkite: [agent tokens](https://buildkite.com/docs/agent/v3/tokens), [`start` flags](https://buildkite.com/docs/agent/v3/cli-start)
- Tailscale: [auth keys](https://tailscale.com/kb/1085/auth-keys), [CLI](https://tailscale.com/kb/1080/cli), [`tailscale up`](https://tailscale.com/kb/1241/tailscale-up)
- Amp: [runners / `--amp-env`](https://ampcode.com/docs/cli/runners), [Mac runner](https://ampcode.com/docs/apps/mac/runner)
- Cursor: [self-hosted machines](https://cursor.com/docs/cloud-agent/self-hosted)
- Devin: [repo setup](https://docs.devin.ai/onboard-devin/repo-setup), [snapshots](https://docs.devin.ai/onboard-devin/snapshots)
- Anthropic: [CMA self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)

---

## 2. User paths

### 2a. Console-first (laptop or desktop with a browser)

1. **Discover.** The sidebar has **Local Runtimes** (`/runtimes`) as a peer of Environments, never under it. The Environment create modal's "Attach to existing Runtime" option links there when no machine is paired. The Agent form's harness picker links there for ACP agents.
2. **Download + install.** Clicking **+ Connect machine** shows `npx @openma/cli bridge setup` (Node ≥ 20). Later phases add a platform-detected tab: a `curl … | sh` installer, a Homebrew tap and a Windows `.msi`/winget, all of which install the same `oma` binary (see §3e).
3. **Pair.** `bridge setup` opens `/connect-runtime`, the user clicks **Allow**, and the code is exchanged. The service is installed and the daemon starts. *(Exists.)*
4. **Verify.** Within 15 seconds the row appears on `/runtimes` as **online**, with detected agents and local skills. *(Exists.)*
5. **Use.**
   - **New in this draft:** Environments → **+ New environment** → Hosting Type **Attach to existing Runtime** → pick the machine (hostname · OS · status) → optional **Env overlay** (`KEY=value` lines) → Create. This creates `config.type: "self_hosted"` with `_oma.runtime { runtime_id, env }`. The Environment detail page shows an editable **Runtime** card for `self_hosted` environments.
   - Today's Agent-level path still works: Agent → harness `acp-proxy` → Runtime + ACP agent (`runtime_binding`).

### 2b. Console + headless machine (SSH box, VM, CI host)

1. On `/runtimes`, click **+ Connect machine** → **Generate pairing command**. *(New.)* The Console calls `POST /v1/oma/runtimes/pairing-tokens` and shows one command:
   `npx -y @openma/cli bridge setup --server-url=https://<host> --token=omrp_<code>_<state>`
   The command is valid for 1 hour and works once.
2. Paste it on the machine. Setup skips the browser, exchanges the token at the unchanged `/agents/runtime/exchange`, installs the service and starts the daemon. *(New flag.)*
3. Continue from step 4 of path 2a.

### 2c. CLI-only (operator scripting or remote provisioning)

```bash
# On a machine where you're logged in (oma auth login):
oma runtime pair [--ttl 3600]          # new: prints the one-time setup command (or --json)
# On the target machine (or via ssh/cloud-init/Ansible):
OMA_PAIRING_TOKEN=omrp_… npx -y @openma/cli bridge setup --server-url=https://<host>   # new: env form
oma runtime list                       # exists: id, hostname, status, agents, heartbeat
oma bridge status                      # exists (on the machine)
# Choose/configure (today via API; first-class CLI verbs are Phase 2):
curl -X POST $BASE/v1/environments -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{
  "name": "mbp", "config": {"type": "self_hosted"},
  "_oma": {"runtime": {"runtime_id": "<id>", "env": {"NODE_ENV": "development"}}}
}'
oma sessions create --agent <id> --env <env_id>
oma runtime rm <id>                    # exists: revoke
```

---

## 3. Implementation plan

### 3a. API / schema

| Change | Status | Notes |
|---|---|---|
| `POST /v1/oma/runtimes/pairing-tokens {ttl_seconds?}` → `201 {pairing_token, expires_at, install_command}` | **Implemented** | Reuses the `connect_runtime_codes` row (the server also picks `state`). TTL 300 s – 24 h, default 1 h. Single use comes from the existing `/exchange`. No migration. |
| Token format `omrp_<code>_<state>` (both hex) | **Implemented** in `@open-managed-agents/api-types` (`formatRuntimePairingToken` / `parseRuntimePairingToken`) | Shared by server, CLI and Console. The prefix makes leaked tokens easy to find with grep. |
| `Environment._oma.runtime { runtime_id, env }` | **Implemented** across domain, application, contract and mapper | Allowed only on `self_hosted`. Cloud + runtime is rejected, which enforces sandbox XOR Runtime. Env names must match `[A-Za-z_][A-Za-z0-9_]*`. The write replaces the whole attachment, `null` detaches, and it is omitted on the wire when unset (the official SDK still parses it). Stored in the existing `document` JSON, so no migration. |
| Bundle merges the Environment overlay | **Implemented** | `GET /agents/runtime/sessions/:sid/bundle` reads the session's Environment. The overlay is served **only if** the Environment is live and `_oma.runtime.runtime_id` equals the authenticated runtime. Session `env` resources override it by name. |
| `_oma.runtime.secret_env` (write-only names → sealed values) | Phase 2 | Reuse the `session-secrets-store` sealing (`CfManagedSessionSecretSealer`) keyed by environment. GET returns names only. Alternatively, reference vault credentials of type `command_secret`. |
| Session placement from the Environment | Phase 2 | When `environment._oma.runtime` is set, session create derives `runtime_binding.runtime_id` from it and needs only the ACP agent from the Agent. If the Agent already has a different `runtime_binding`, reject with 409 rather than guess. |
| `GET /v1/oma/runtimes/:id`, `PATCH {name, labels}` | Phase 2 | Display name and labels (Buildkite-style tags) for picker filtering and future pools. |
| Pending pairing-token list + revoke | Phase 2 | `GET/DELETE /v1/oma/runtimes/pairing-tokens`. Store a `sha256(code)` instead of the plaintext code; the existing browser flow stores plaintext. |
| Shared runtimes (`--share`, Amp-style) | Phase 3 | Today a runtime is owned by one user (`owner_user_id`). Sharing needs an explicit workspace-visibility flag plus an "others run code as you" warning. |

### 3b. CLI commands

| Command | Status |
|---|---|
| `oma runtime pair [--ttl <s>] [--json]` | **Implemented** |
| `oma bridge setup --token=omrp_…` / `OMA_PAIRING_TOKEN` | **Implemented**. Implies re-registration and fails fast on a malformed token before any network call. |
| `oma runtime list`, `oma runtime rm` | Exist |
| `oma env create --runtime <id> [--env K=V …]`, `oma env set-runtime <env> <runtime>\|--detach` | Phase 2 (the CLI has no `env` group yet) |
| `oma runtime install` (prints/runs the platform installer), `oma bridge upgrade` | Phase 3, after the standalone binary exists |
| `oma runtime` is the user-auth noun; `oma bridge` is the machine-side noun | Keep the split. `runtime pair` mints, `bridge setup` consumes. |

### 3c. Console screens

| Screen | Status |
|---|---|
| `/runtimes` → Connect machine → **Generate pairing command** (`HeadlessPairing`) | **Implemented** |
| Environments → New → Hosting Type **Cloud — provision a sandbox** / **Attach to existing Runtime** → runtime picker + env overlay (`RuntimeAttachmentFields`) | **Implemented** |
| Environment detail → **Runtime** card for `self_hosted` (edit or detach the runtime, edit the overlay, inline line errors block Save) | **Implemented** |
| Environments list "Type" column shows `runtime` for attached environments | **Implemented** |
| Runtime detail page (agents, local skills, Environments attached, last sessions, pending pairing tokens) | Phase 2 |
| Overlay **secrets** rows (masked, write-only) and an "effective env" preview with precedence | Phase 2 |
| Session create: when the Environment is attached and the runtime is offline, warn (the session would queue) | Phase 2 |

### 3d. Pairing / auth model

- **Interactive** (exists): loopback + `state`. This is effectively OAuth for native apps; the code is single use with a 5-minute TTL.
- **Headless** (new): a server-minted `(code, state)` pair delivered as `omrp_…`. It has the same single-use row and the same `/exchange`, so the credential it yields is identical: `sk_machine_*` (hash stored) plus per-workspace `oma_*` keys. The token is a **bearer secret until used**. The Console tells users to treat it like a password, and the 1-hour default bounds the exposure window.
- **Considered and deferred: an RFC 8628 device code** (`oma bridge setup --device` prints `ABCD-EFGH` + URL, polls `/agents/runtime/device/token`). Device code is better when the user is *at* the headless box with a browser elsewhere (SSH session). The pairing token is better for automation (cloud-init, Ansible), and it reused 100% of the existing server path. Ship both eventually. The device code would be a new `connect_runtime_codes` mode with a `user_code` column.
- **Reusable / unattended keys** (Buildkite agent token, Tailscale reusable key) for fleets: Phase 3. They need workspace-owned (not user-owned) runtimes first.

### 3e. Packaging / distribution

| Phase | Channel |
|---|---|
| Now | `npx -y @openma/cli bridge setup` (Node ≥ 20). The service unit pins `process.execPath` + the realpath'd entry point (existing behaviour). |
| Phase 2 | `curl -fsSL https://<host>/install.sh \| sh -s -- --token=omrp_…`, a thin script that checks for Node and runs a pinned `npx @openma/cli@<ver>`. The Console renders it with the deployment's own origin, which matters for self-hosters. |
| Phase 3 | Single-file binaries (Node SEA or bun-compile) on GitHub Releases plus a Homebrew tap and winget. The daemon reports `version` (already in `runtimes.version`) and the Console flags outdated runtimes. `oma bridge upgrade` updates the binary. |

### 3f. Milestones

- **M1 (this draft):** headless pairing (API, CLI, Console), Environment `_oma.runtime` + env overlay (API, Console create and edit), overlay delivered to the daemon bundle, tests.
- **M2:** session placement derived from the Environment, sealed `secret_env`, runtime display name and labels, Runtime detail page, pending-token revoke, hashed codes, `oma env` CLI verbs.
- **M3:** install script, standalone binary + update check, device-code login, shared/workspace runtimes and reusable pairing keys, labels → pools.

---

## 4. What users can actually use in this first draft

**Works end to end:**

- Pair a headless machine. Run `oma runtime pair` or use Console → Generate pairing command, then paste the command on the machine. It shows up in `oma runtime list` and on `/runtimes`. Covered by an integration test against the real worker + D1: minted token → `/exchange` succeeds once, a replay gets 400 "code already used", and bad TTLs and anonymous callers are rejected.
- Create or edit a `self_hosted` Environment attached to a Runtime, with an env overlay, from the Console or the API. The API enforces sandbox XOR Runtime and valid env names.
- The daemon receives the overlay in the session bundle and exports it into the spawned ACP agent's process env (so its shell, stdio MCP servers and plugins inherit it). This happens only when the session's Environment is attached to **that** runtime. Session `env` resources win on conflicts.

**Not yet (be explicit with users):**

- **Attaching an Environment does not route sessions to the machine yet.** Routing still comes from the Agent (`harness: acp-proxy` + `runtime_binding`). For the overlay to apply today, the session must use an Agent bound to the same runtime **and** the attached Environment. M2 makes the Environment authoritative.
- I did not verify end to end that `session.environment_id` is populated on the session record the bundle route reads for every session-creation path. That needs a live check, and the overlay silently degrades to "none" if it is missing.
- The overlay holds **plain values only**, and workspace members can read them through `GET /v1/environments/:id`. Secrets should keep using vaults or session `env` resources until `secret_env` lands.
- Runtimes are still owned by one user. Another workspace member can't pick your machine, and the picker lists only *your* runtimes. An Environment pointing at a colleague's runtime shows as "revoked or not yours".
- No pending-token list or revoke. Unused tokens expire, by default after 1 hour.
- Node ≥ 20 is required on the target machine (npx). There is no standalone binary yet.

---

## 5. Open questions for the owner

1. **Who owns a Runtime: user or workspace?** Today it's `owner_user_id` plus per-tenant keys. Environments are workspace resources, so an attached Environment created by A is unusable by B. Options: (a) keep user-owned and allow attach only to your own machines (current), (b) Amp-style explicit `--share` to the workspace, (c) workspace-owned runtimes created with a workspace pairing key. My lean is (b) for laptops and (c) for servers.
2. **Is the Environment or the Agent authoritative for placement?** Proposal: the Environment decides *where* (runtime), the Agent decides *what* (ACP agent / harness), and a conflict at session create returns 409. Should `runtime_binding.runtime_id` on Agents be deprecated once M2 ships?
3. **Overlay secrets: seal into our session-secret store, or require vault references?** Sealed `secret_env` is simplest for users (it matches Amp's "Secrets & Env Vars"). Vault references keep one credential system, but `command_secret` today means "inject into matching commands", not "export to the runner".
4. **Overlay precedence and scope.** Amp layers personal > project > workspace. We have session resources > Environment overlay > daemon env. Do we also want a per-user or per-Runtime overlay (for example, a machine-local `PATH` tweak configured in the Console)?
5. **Should the overlay reach the daemon process itself** (for example proxy settings for the daemon's own HTTP calls), or only the agent child processes (the current behaviour)?
6. **Pairing default TTL and maximum.** I chose 1 h default and 24 h maximum, matching GitHub's 1 h. Does cloud-init/AMI baking need a longer TTL, or reusable keys (M3)?
7. **Device-code flow:** is it worth adding in M2 for the "SSH into a box, browser on laptop" case, or is `oma runtime pair` from the laptop enough?
8. **CMA compatibility:** an attached Environment is `self_hosted` to CMA clients. Should sessions on it also be visible to unmodified AMA workers polling `/work` (dual-serving), or should the attachment make the Environment OpenMA-runtime-only and reject polling?
9. **Distribution:** is a Node SEA/bun single binary acceptable (size around 60–90 MB), or should we stay npm-only and invest in the install script?

---

## Appendix — files touched by the M1 slice

- API types: `packages/api-types/src/runtime-pairing.ts` (+ `index.ts` export)
- Environment extension: `packages/managed-agents-domain/src/environments/environment.ts`, `packages/managed-agents-application/src/{ports,environments}/…`, `packages/managed-agents-api/src/{contracts,mappers}/environments.ts`
- Server: `apps/main/src/routes/runtimes.ts` (pairing-tokens route, `runtimeEnvironmentOverlay`, bundle merge)
- CLI: `packages/cli/src/bridge/lib/pairing.ts`, `bridge/commands/setup.ts`, `src/index.ts` (`runtime pair`, `--token`, help), `.changeset/runtime-headless-pairing.md`
- Console: `src/lib/env-overlay.ts`, `src/components/RuntimeAttachmentFields.tsx`, `src/pages/{EnvironmentsList,EnvironmentDetail,RuntimesList}.tsx`, `src/lib/managed-api.ts`
- Tests: `packages/managed-agents-api/test/environments-runtime-attachment.contract.test.ts`, `packages/managed-agents-application/test/environments-application.test.ts`, `test/integration/runtimes-route.test.ts`, `packages/cli/test/pairing.test.ts`, `apps/console/src/lib/env-overlay.test.ts`, `apps/console/src/pages/EnvironmentDetail.runtime.test.tsx`
