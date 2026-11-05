# Runtime discovery, download, pairing and selection: design memo

Status: **Draft** (updated 2026-11-05; owner decisions + T3/peer recommendations recorded) · Branch `draft/runtime-download-selection`
Issues: [#449](https://github.com/openma-ai/open-managed-agents/issues/449) (Amp-style env+secrets overlay), [#415](https://github.com/openma-ai/open-managed-agents/issues/415) (Console product-surface gaps)
Related: [ADR 0005](../adr/0005-self-hosted-worker-runtime-resources.md), [v1-architecture](../v1-architecture.md), [archive/external-agent-runtime](../archive/external-agent-runtime.md)

**Question.** How do users discover, download, install and pair the local runtime, and how do they choose and configure a runtime from the Console and from the CLI?

**Owner decisions this memo follows.**

1. One machine is one **Runtime**. A Runtime is a peer API resource to Environment (`/v1/oma/runtimes`) and is never nested under it.
2. A **Runtime** pairs the whole machine once (identity and connection). It still records a pairing `owner_user_id` for audit, but **authorization is workspace-centric**, not user-centric (see Decisions §5). It reports Git, Docker/LiteBox capability, supported sandbox modes and available resources. An **Environment** binds a Runtime and chooses placement and directories; a **Session** runs within it, and the daemon re-validates locally. Cloud-provisioned Environments remain available separately.
3. An Amp `--amp-env`-style **env + secrets overlay**, configured in the Console, is injected into the host runner (its shell, MCP servers and plugins).
4. **Converge Runtime ACP install root** on Backchat's layout: `~/.oma/acp/registry/…`. Do not keep a separate Martty install-root layout.
5. **Skills: one copy in the unified cache**; sessions soft-link into that cache (not skillId@version-only mounts as the sole storage).
6. **Skill update strategy matches cloud / CMA:** Agent binds `{ skill_id, type, version? }` with omitted version → `"latest"`; materialize resolves `latest` to a concrete Skill Version into the unified cache; session soft-links point at that concrete content. Updating a skill creates a new Version and moves `latestVersion`; **running Sessions do not hot-swap** — they keep the Agent snapshot from create time. Pinned versions stay pinned; `latest` picks up new content only on a new Session (or an explicit rebinding). No local-only auto-refresh / background re-link.
7. **Permissions are workspace-centric.** Shared Environments on a Runtime are authorized by workspace membership/grant, not by per-user ownership alone. Users may clear Runtime/Environment state from the machine or from Console.
8. **Git worktree edit mode defaults on** for eligible Git entries; the Environment editor lets the user cancel/opt out to `in_place` (or Use existing).
9. **Sessions must not know about each other.** No cross-session directory awareness, coordination UI, or privacy-motivated hard reject of overlapping ancestor/descendant paths across Sessions. Leases may still serialize the same real path silently without sessions seeing each other.
10. **Initial Runtime-owned sandbox backend = LiteBox**, talking to the **local daemon**; the daemon talks to the OMA control plane. This is distinct from Cloud Environment `SANDBOX_PROVIDER=litebox` on the Node control-plane path. Do not treat OpenSandbox Docker as the Runtime-attached default unless a later decision reopens it.

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

**Baseline gaps before M1 (implementation status below):**

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
| **T3 Code** | Machine-local control plane; clients use authenticated RPC | Standalone CLI installer, desktop downloads/package managers, or `npx` trial. Separate start, service, update and uninstall commands. | T3 Connect account discovery; SSH sign-in URL + code; direct one-time pairing URL/QR creates a reusable client session. | Select a connected environment; execution, files and provider credentials remain on its machine. LAN, SSH, Tailscale and Connect are connection routes. | Persistent `service.env` for service startup; provider-instance env settings are a separate layer. |

**What carries over to OpenMA:**

- **Separate interactive and unattended pairing.** Browser loopback + PKCE serves machines with a browser; RFC 8628 device authorization serves headless interactive use. A short-lived, single-use pairing command remains a bootstrap fallback, following GitHub registration tokens and Tailscale one-off keys. Existing loopback and token support do not yet implement the full target.
- **Short TTL, single use, one command.** GitHub uses 1 hour, and Tailscale one-off keys are revoked on use. The UI hands over one full command, not a token plus instructions.
- **Selection belongs where the work is placed.** Amp uses a thread location picker, Cursor a pool, CMA an `environment_id`. In OpenMA that place is the **Environment**. "Attach to Runtime" is our equivalent of CMA's self-hosted Environment, except the queue is one known machine rather than any worker.
- **Overlay precedence matters.** Amp's personal > project > workspace > process order maps to session `env` resources > Environment overlay > daemon process env.
- **Health is part of selection.** CMA's `workers_polling` and Amp hiding runners that serve no directories both point the same way. The Console picker should show online/offline, and later the detected agents.

**T3 Code lessons for this draft** (official docs/source inspected 2026-11-05; no product execution test):

- **Discovery must lead to the execution machine.** Its [README](https://github.com/pingdotgg/t3code/blob/main/README.md) separates CLI and desktop entry points; [installation](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md) separates a temporary `npx` trial from an installed binary, version/channel selection and provider setup. OpenMA's Connect machine page should identify the target OS, prerequisites and install channel, then show whether the provider is ready on that Runtime. Downloading a client is not proof that a host can execute work.
- **Pairing and reachability need separate states.** T3's [remote-access guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md) distinguishes account discovery, direct pairing and SSH; a pairing URL cannot make an unreachable host reachable. Its SSH sign-in uses another device's browser without forwarding a callback port. For OpenMA, show paired, service running and relay connected separately; keep device authorization as the headless target and explain the existing pasted-token fallback.
- **Treat bootstrap links and established access separately.** T3 can revoke an unused pairing link or an existing client session, with different effects. Its [auth design](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md) separates relay identity from environment authorization, exposes pairing metadata without recoverable secrets, and checks permissions per RPC. OpenMA needs pending-token list/revoke and hashed codes as well as machine-token revocation; an authenticated relay must not grant local directory access.
- **Service diagnostics are part of installation.** T3's [service guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md) explains Linux lingering, macOS login/awake requirements, absent Windows service support, log locations and repair. OpenMA already has its own three-platform service installers; document and verify their actual survival/restart behavior. Report installed versus running versions, preserve configuration across updates, and keep service removal separate from deleting user work. T3's service env file applies at restart; OpenMA's Environment overlay applies to spawned agent children, not the daemon.
- **Remote control needs compatibility and honest update status.** T3's [architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md) keeps filesystem/provider authority on the execution server even for a desktop client. Its [update guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/updating.md) distinguishes service, desktop, global npm and temporary `npx` updates, reports per-machine failure, and refuses incompatible protocols. For OpenMA, tie future upgrade actions to the detected install channel, name the machine being updated, report restart impact and verify reconnect/version before declaring success. This is a design lesson, not functionality shipped by M1.

Sources:

- GitHub: [adding runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/adding-self-hosted-runners), [REST registration-token / JIT](https://docs.github.com/en/rest/actions/self-hosted-runners), [svc.sh](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/configuring-the-self-hosted-runner-application-as-a-service)
- Buildkite: [agent tokens](https://buildkite.com/docs/agent/v3/tokens), [`start` flags](https://buildkite.com/docs/agent/v3/cli-start)
- Tailscale: [auth keys](https://tailscale.com/kb/1085/auth-keys), [CLI](https://tailscale.com/kb/1080/cli), [`tailscale up`](https://tailscale.com/kb/1241/tailscale-up)
- Amp: [runners / `--amp-env`](https://ampcode.com/docs/cli/runners), [Mac runner](https://ampcode.com/docs/apps/mac/runner)
- Cursor: [self-hosted machines](https://cursor.com/docs/cloud-agent/self-hosted)
- Devin: [repo setup](https://docs.devin.ai/onboard-devin/repo-setup), [snapshots](https://docs.devin.ai/onboard-devin/snapshots)
- Anthropic: [CMA self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
- T3 Code: [site](https://t3.codes/), [official source](https://github.com/pingdotgg/t3code); specific documentation linked above. T3's “environment” is its execution server, not a one-to-one equivalent of OpenMA's Environment policy resource.

---

## 2. User paths

### 2a. Console-first (laptop or desktop with a browser)

1. **Discover.** The sidebar has **Local Runtimes** (`/runtimes`) as a peer of Environments, never under it. The Environment create modal's "Attach to existing Runtime" option links there when no machine is paired. The Agent form's harness picker links there for ACP agents.
2. **Download + install.** Clicking **+ Connect machine** shows `npx @openma/cli bridge setup` (Node ≥ 20). Later phases add a platform-detected tab: a `curl … | sh` installer, a Homebrew tap and a Windows `.msi`/winget, all of which install the same `oma` binary (see §3e).
3. **Pair.** `bridge setup` opens `/connect-runtime`, the user clicks **Allow**, and the code is exchanged. The service is installed and the daemon starts. Loopback + state exists; add PKCE for the target flow.
4. **Verify.** Within 15 seconds the row appears on `/runtimes` as **online**, with detected agents and local skills. *(Exists.)*
5. **Use.**
   - **New in this draft:** Environments → **+ New environment** → Hosting Type **Attach to existing Runtime** → pick the machine (hostname · OS · status) → optional **Env overlay** (`KEY=value` lines) → Create. This creates `config.type: "self_hosted"` with `_oma.runtime { runtime_id, env }`. The Environment detail page shows an editable **Runtime** card for `self_hosted` environments.
   - Today's Agent-level path still works: Agent → harness `acp-proxy` → Runtime + ACP agent (`runtime_binding`).

### 2b. Headless machine (SSH box, VM, CI host)

Target default: `oma bridge setup --device` displays a verification URL and user code, then polls using RFC 8628 until the owner approves the machine. The existing token command below remains the manual/bootstrap fallback.

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
| `Environment._oma.runtime { runtime_id, placement, env }` | **Implemented** across domain, application, contract and mapper | Current schema allows attachment only on `self_hosted` and rejects cloud + runtime. This is an existing schema constraint, not the target placement rule: a Runtime can own a local sandbox. Placement is `host` or `sandbox`, defaults to `host`, and rejects custom directories in this slice. Env names must match `[A-Za-z_][A-Za-z0-9_]*`. The write replaces the whole attachment, `null` detaches, and it is omitted on the wire when unset (the official SDK still parses it). Stored in the existing `document` JSON, so no migration. |
| Bundle merges the Environment overlay | **Implemented** | `GET /agents/runtime/sessions/:sid/bundle` reads canonical managed Sessions first, with a legacy-session fallback, using the authenticated machine's primary workspace shard. It uses the pinned Agent and rejects archived Sessions or another Runtime's binding. The overlay is served **only if** the Environment is live and `_oma.runtime.runtime_id` equals the authenticated runtime. Legacy session `env` resources override it by name. |
| `_oma.runtime.secret_env` (write-only names → sealed values) | Phase 2 | Reuse the `session-secrets-store` sealing (`CfManagedSessionSecretSealer`) keyed by environment. GET returns names only. Alternatively, reference vault credentials of type `command_secret`. |
| Environment-authoritative routing and host directories | Phase 2 | When `environment._oma.runtime` is set, a Session starts from its configured directories, primary cwd and additional roots (harness-dependent); session create derives `runtime_binding.runtime_id` from it and needs only the ACP agent from the Agent. If the Agent already has a different `runtime_binding`, reject with 409 rather than guess. |
| `GET /v1/oma/runtimes/:id`, `PATCH {name, labels}` | Phase 2 | Display name and labels (Buildkite-style tags) for picker filtering and future pools. |
| Pending pairing-token list + revoke | Phase 2 | `GET/DELETE /v1/oma/runtimes/pairing-tokens`. Store a `sha256(code)` instead of the plaintext code; the existing browser flow stores plaintext. |
| Runtime ownership / grants | Decided (refined) | Pairing still records `owner_user_id` for audit. **Environment attachment and use are workspace-centric:** workspace membership/grant authorizes attaching and editing a shared Environment on a Runtime. Local directory approval remains a machine-side grant (`allow-dir` / local confirm). Users may clear Runtime/Environment state from the machine or Console. |

### 3b. CLI commands

| Command | Status |
|---|---|
| `oma runtime pair [--ttl <s>] [--json]` | **Implemented** |
| `oma bridge setup --token=omrp_…` / `OMA_PAIRING_TOKEN` | **Implemented**. Implies re-registration and fails fast on a malformed token before any network call. |
| `oma runtime list`, `oma runtime rm` | Exist |
| `oma bridge setup --device`, `oma bridge allow-dir <path>`, `oma bridge dirs list` | Proposed: device pairing and local owner authorization, independent of GitHub OAuth |
| `oma env create --runtime <id> [--env K=V …]`, `oma env set-runtime <env> <runtime>\|--detach` | Phase 2 (the CLI has no `env` group yet) |
| `oma runtime install` (prints/runs the platform installer), `oma bridge upgrade` | Phase 3, after the standalone binary exists |
| `oma runtime` is the user-auth noun; `oma bridge` is the machine-side noun | Keep the split. `runtime pair` mints, `bridge setup` consumes. |

### 3c. Console screens

| Screen | Status |
|---|---|
| `/runtimes` → Connect machine → **Generate pairing command** (`HeadlessPairing`) | **Implemented** |
| Environments → New → Hosting Type **Cloud: provision a sandbox** / **Attach to existing Runtime** → runtime picker + env overlay (`RuntimeAttachmentFields`) | **Implemented** |
| Environment detail → **Runtime** card for `self_hosted` (edit or detach the runtime, edit the overlay, inline line errors block Save) | **Implemented** |
| Environments list "Type" column shows `runtime` for attached environments | **Implemented** |
| Runtime detail page (agents, local skills, Environments attached, last sessions, pending pairing tokens) | Phase 2 |
| Overlay **secrets** rows (masked, write-only) and an "effective env" preview with precedence | Phase 2 |
| Environment placement editor and Session view | Proposed: Environment owns placement, directory/subpath picker, primary and edit modes; Session shows effective paths, branches and queue state |
| Session create: when the Environment is attached and the runtime is offline, warn (the session would queue) | Phase 2 |

### 3d. Pairing / auth model

- **Browser machine:** loopback authorization code + PKCE, state nonce, exact loopback redirect, short expiry and one-time exchange. Existing loopback + state needs PKCE added. Show machine identity and owner before approval; never return long-lived credentials in redirect URLs. [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252).
- **Headless machine:** RFC 8628 device code is the target interactive flow, not a deferred alternative. Print verification URL and short user code; poll with a separate high-entropy device credential, respecting expiry and polling intervals. The browser approves the exact machine. [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628).
- **Fallback/bootstrap:** existing `omrp_<code>_<state>` is a short-lived, single-use bearer pairing token. Current default is 1 hour (API range 300 seconds to 24 hours). Keep it out of logs and persistence; prefer secure input for automation.
- All three flows exchange into the same revocable Runtime credential contract (`sk_machine_*` plus current per-workspace `oma_*` keys). Separate human login from machine authorization and local directory grants. Serving a plain folder must not require GitHub OAuth. Protect credentials locally and support revocation/rotation.

### 3e. Packaging / distribution

| Phase | Channel |
|---|---|
| Now | `npx -y @openma/cli bridge setup` (Node ≥ 20). The service unit pins `process.execPath` + the realpath'd entry point (existing behaviour). |
| Phase 3, first step | `curl -fsSL https://<host>/install.sh \| sh -s -- --token=omrp_…`, a thin script that checks for Node and runs a pinned `npx @openma/cli@<ver>`. The Console renders it with the deployment's own origin, which matters for self-hosters. |
| Phase 3 | Single-file binaries (Node SEA or bun-compile) on GitHub Releases plus a Homebrew tap and winget. The daemon reports `version` (already in `runtimes.version`) and the Console flags outdated runtimes. `oma bridge upgrade` updates the binary. |

### 3f. Milestones

- **M1 (this draft):** headless pairing (API, CLI, Console), Environment `_oma.runtime` + env overlay (API, Console create and edit), overlay delivered to the daemon bundle, unified host skill cache + Session soft-links with concrete-version pinning, **placement=sandbox using LiteBox on the attached Runtime** (daemon-local allocation/resume, per-session ownership, selected skill copies), placement picker and tests. LiteBox daemon coverage is mocked; live evidence is deferred.
- **M2:** Environment-authoritative routing and local directory grants, in-place queues and default-on/opt-out safe worktrees, loopback PKCE and device authorization, sealed `secret_env`, runtime display name and labels, Runtime detail page, pending-token revoke, hashed codes, `oma env` CLI verbs.
- **M3:** install script, standalone binary + update check, additional sandbox backends and optional host confinement. Any fleet/pool design must preserve workspace-centric attachment permissions and machine-local directory authorization.

---

## 4. What users can actually use in this first draft

**Implemented paths and evidence:**

- Pair a headless machine. Run `oma runtime pair` or use Console → Generate pairing command, then paste the command on the machine. It shows up in `oma runtime list` and on `/runtimes`. Covered by an integration test against the real worker + D1: minted token → `/exchange` succeeds once, a replay gets 400 "code already used", and bad TTLs and anonymous callers are rejected.
- Create or edit a `self_hosted` Environment attached to a Runtime, with an env overlay, from the Console or the API. The current API enforces the cloud/attachment schema constraint and valid env names. Choose Host (default) or Sandbox (LiteBox on the Runtime); directories remain rejected.
- The bundle endpoint returns the overlay for an Environment attached to **that** runtime. A worker/D1 integration test creates an Agent, Environment and Session through `/v1`, then fetches the authenticated bundle. Before this follow-up it returned 404 because the route only read legacy Sessions; it now reads canonical Sessions first, retaining the legacy fallback. Tests cover pinned Agent instructions, isolation, archive, overlay edits/detach and legacy session `env` precedence. The existing daemon merges bundle env into spawned ACP children; this test stops at delivery and does not start a provider.

- **Unified host skill cache is implemented in M1.** New bridge bundles (`skill_cache=1`) carry skill bindings from the pinned Session Agent snapshot. The daemon resolves omitted/`latest` once through the Skills API, stores concrete versions in the session's `.oma-skills.json`, and downloads full packages into `~/.oma/cache/skills/<scope>/<skill_id>/<version>/`. `<scope>` hashes deployment URL + workspace, preventing equal IDs from different installations colliding. Sessions link `skills/<skill_id>` to that immutable package; Claude's managed config links directly to its manifest directory. Generic ACP context names the managed paths in `AGENTS.md` and `OPENMA_SKILLS_DIR`; project directories receive no links or extracts. Cache hits do not rewrite content; binary attachments are preserved, files are read-only, SHA-256 metadata checks integrity, and concurrent fills publish atomically. Existing Sessions retain their pin across daemon restart/bundle reapply; new Sessions resolve a moved latest. Changed bindings on an existing local snapshot fail explicitly; use a new Session to rebind in this slice.

### Known limits — review before using this draft

- **Attaching an Environment does not route sessions to the machine yet.** Routing still comes from the Agent (`harness: acp-proxy` + `runtime_binding`). For the overlay to apply today, the session must use an Agent bound to the same runtime **and** the attached Environment. M2 makes the Environment authoritative.
- In the canonical `/v1/sessions` path, `config.type: self_hosted` selects the existing Environment Work queue. An attachment does not connect that queue to the local bridge. The new bundle lookup removes a delivery gap; it does not implement queue consumption or change scheduling. The bundle still scopes requests to the machine's **primary workspace**, not all entries in `authorized_tenants`.
- The overlay holds **plaintext values**, stored with the Environment and readable by workspace members through its API. There is no `secret_env`, encryption/write-only secret editor, secret masking or effective-env preview. Use vault credentials for secrets; do not paste them into this editor.
- Overlay delivery requires a live Environment whose attached Runtime matches the Agent-bound Runtime. A detached attachment contributes no overlay and defaults to host. Missing/archived Environments, mismatched Runtime attachments and lookup errors fail bundle delivery so an intended sandbox cannot silently become host. The Environment is read at bundle fetch time, not pinned to a Session policy revision; edits do not update an already-running child or restart its MCP servers. This is not Amp's full refresh behavior. Session `env` precedence applies to the legacy OMA resource contract; canonical CMA resources do not accept `env`.
- **Attachment authorization is incomplete.** Runtime listing and the picker are still user-scoped; the Environment API currently validates shape/type/env names, but does not verify that `runtime_id` exists or that the writer has a workspace grant to that Runtime. Do not treat picker filtering as an authorization boundary. Bundle access checks the machine credential and Agent binding. Environment-authoritative routing must add **server-side workspace-grant checks** (not per-user ownership alone) before granting execution rights.
- No pending-token list/revoke, hashed bootstrap codes, device authorization or loopback PKCE yet. Browser and fallback codes use the existing plaintext `connect_runtime_codes` storage. Fallback tokens expire after 1 hour by default (allowed range 5 minutes–24 hours) and exchange once. Revoking a registered Runtime is separate from revoking an unused pairing command. Copied `--token` commands may remain in shell history.
- Download is still `npx @openma/cli` with **Node ≥ 20** on the host. This branch's CLI additions require a build/release containing them; unversioned `npx` resolves the published package and is not evidence that draft flags are available. No standalone binary, deployment installer, update channel or upgrade/reconnect UX ships here.
- Host custom directories and approval/browsing, in-place queues, managed worktrees, cleanup/retention and Mac support below are **design only**. Placement selection and daemon-local LiteBox allocation/resume are implemented in M1. Host placement still runs with the Runtime user's filesystem access. No Runtime detail page or `oma env` command group ships here.
- **Host cache limits:** Windows first tries a directory symlink, then a junction, then a logged immutable copy fallback (unit-tested with mocked failures). Read-only modes prevent ordinary accidental writes; this is not a security boundary against the host account. No background refresh or cache eviction ships; TODO live-session-aware GC and abandoned-writer lock recovery. An interrupted writer may require operator inspection/removal of its lock; never delete a live linked entry. Older daemons/servers retain the legacy text-bundle protocol. Local user-installed skills keep their existing detection/filter behavior; only platform-managed Skill Versions enter this cache. Writable memory stores are unchanged and are not shared by these links.
- **Sandbox boundary:** M1 ships LiteBox on the attached Runtime through `createBoxLiteProvider({ providerId: "litebox" })`, using an embedded local connection. One Session owns one box, keyed by the provider's session-specific stable name; resume validates the saved `litebox` handle. Sessions have no cross-session awareness: no other Session's handles, paths or caches enter a jail. `prepareSandboxBundle` copies only selected immutable packages from host `~/.oma/cache/skills` with `writeFileBytes` and creates jail-local links. No custom Environment host directories or host config are mounted. Operators install the optional `@boxlite-ai/boxlite` peer and provide `SANDBOX_IMAGE` with the ACP binary; the default `node:22-bookworm` alone does not supply that binary. Cloud/boxrun REST configuration is rejected. Live LiteBox-on-Runtime daemon evidence remains deferred; see [the mocked coverage receipt](../screenshots/498/receipts/runtime-placement-sandbox/README.md).
- Verification in this PR uses local worker/D1 integration, contract and Console tests, plus live PR-lane skill materialization receipts under `docs/screenshots/498/receipts/skill-cache/`. The new skill-cache receipts are from Linux; botty Mac validation remains blocked by unavailable remote execution access. The skill probe does not claim ACP inference, Environment Work queue consumption, Mac execution, service survival or non-Cloudflare validation. No external model inference is needed for these tests.

---

## Environment placement: sandbox vs host, default vs custom directories

### Layers and placement choices

Pair the **whole machine once**, independent of folders or GitHub. The Runtime reports Git present, local LiteBox capability, supported sandbox modes, resources and online status. The Environment binds `runtime_id` and chooses placement, directories and edit modes. A Session references the Environment and runs within it, carrying no directory choices and at most an optional `slug` for branch naming. The daemon checks capabilities, current policy and real paths immediately before launch/resume, rejecting unavailable or out-of-bounds choices without silently falling back to scratch or in-place editing.

The Environment placement design must account for Deployments ([#448](https://github.com/openma-ai/open-managed-agents/issues/448)).

The two axes are **sandbox or host** and **custom directory or default directory**. There are three effective combinations; custom host directories are never mounted into sandbox mode.

| Placement | Files and execution | Resource injection |
|---|---|---|
| Sandbox | Independent container/microVM on the Runtime machine's own resources; no host directory mounts. Runtime retention covers the container and persisted volumes/snapshots (see below) | Files arrive through resources, e.g. clone a GitHub repository inside the sandbox |
| Host, default directory | Today's per-session scratch directory `~/.oma/bridge/sessions/<12hex>/` | GitHub repository and other resource injection remain allowed |
| Host, custom directories | The Environment selects roots/subpaths and primary start cwd; others are additional workspace roots (harness-dependent). Each Session instantiates the configured in-place entries or Git worktrees | No GitHub repository resource injection, avoiding duplicate copies and ambiguous cwd; an optional Git credential (token) alone may enable push/PR |

**Initial Runtime-owned sandbox backend = LiteBox on the attached Runtime**, implemented in M1 using `@open-managed-agents/managed-runtime-boxlite` / `createBoxLiteProvider` with `providerId: "litebox"` and an embedded local connection. LiteBox runs locally under the daemon. Each Session gets its own box; no other Session's handles, paths or caches are exposed inside it. Owner direction (2026-11-05): LiteBox network targets the **local daemon**; the daemon talks to the OMA control plane. Register each resulting sandbox as owned by that Runtime. This is **distinct** from Cloud Environment `SANDBOX_PROVIDER=litebox` on the Node control-plane path ([docs/self-host.md](../self-host.md), live receipts under `docs/screenshots/498/receipts/litebox-local/`). T3 Code does not ship a LiteBox/OpenSandbox Runtime backend — it keeps execution on the host environment and can treat a Docker sandbox as an ordinary SSH host ([Docker + T3](https://docs.docker.com/ai/sandboxes/integrations/t3-code/)) — so OpenMA is not matching T3 here; it is following the owner LiteBox-on-Runtime decision. OpenSandbox Docker remains available as a **separate** control-plane/`SANDBOX_PROVIDER=opensandbox` path, not the Runtime-attached default. Later Runtime backend candidates if LiteBox gates fail on a platform: Apple Containerization or Lima on macOS, Firecracker/microVM alternatives on Linux, BoxRun when the host has no local KVM.

Sandbox retention is **design only**, Runtime-level: `sandbox_retention_days` defaults to **30**, with the same policy as worktrees and the shared `max_workspace_bytes` disk cap. LiteBox VMs and their persisted volumes/snapshots belong to the Session. Pause or stop idle sandboxes after an idle timeout; archive starts the retention clock, and `0` means cleanup at archive. Running Sessions are never reclaimed. At expiry, the daemon exports files the agent produced through OMA's existing sync to the Session outputs/artifacts store, then removes the VM, volumes/snapshots and images pulled solely for that Session. If export fails, retain the sandbox and report `cleanup_blocked`. Shared base images stay in an LRU image cache with its own size cap. Console reports reclaimed bytes. See **Archive and cleanup** for cap eviction and manual cleanup.

Lightweight OS-level confinement (Seatbelt/bubblewrap, e.g. Codex `workspace-write` and Claude Code `sandbox-runtime`) is optional future **host-mode hardening**, not sandbox mode. Served directories select the start cwd and additional workspace roots; they do not confine commands. Worktrees separate checkouts and branches, not process permissions.

### Runtime-local directories and authorization

Today `acpSessionStartCwd` is set only from `agent.runtime_binding` through `resolveRepositoryLocalPath`, using a `github_repository` resource's `local_path` (see `apps/agent/src/runtime/session-do.ts` around L6369 and `apps/agent/src/harness/acp-proxy-delivery.ts`). Otherwise the daemon uses scratch. This couples execution location to GitHub metadata.

Replace that coupling with a **Runtime-local path and stable `directory_id`**. Detect Git locally through `.git` (directory or worktree file); any remote or no remote is valid. Non-Git folders are first-class, edited in place and never automatically initialized with Git. Repository metadata is optional integration/provenance, not directory identity.

Custom roots still require a **machine-side** grant: `oma bridge allow-dir <path>`, or a **local confirmation prompt** the first time Console references a path. Remote clients may request approval but cannot add authorized paths themselves. Workspace membership may authorize attaching/editing a shared Environment on that Runtime (see Decisions), but it does **not** bypass local directory approval.

An authorized root authorizes its **whole subtree**. The Environment owns `placement: sandbox|host`, `directories: [{ directory_id, subpath?, edit_mode }]` with `edit_mode: in_place|worktree`, and `primary`, a zero-based entry index selecting the start cwd. Each subpath is relative. Other entries become additional workspace roots, such as ACP additional directories or Claude Code `--add-dir`; support is harness-dependent. Reject unsupported multi-root placement explicitly. The Environment also owns per-repo `repositories: [{ directory_id, base_branch?, existing_checkout? }]` and a branch slug template. Retention is configured on the Runtime, not the Environment.

Validate when the Environment is saved and re-check in the daemon at Session launch/resume: roots must be locally authorized and current; resolve roots and requested paths to real paths, including symlinks and `..`, and check containment by path components. Reject duplicate or overlapping ancestor/descendant entries, including effective paths after checkout mapping, non-Git entries using anything but `in_place`, and custom directories combined with GitHub repository injection. Console browsing stays within authorized roots.

Session pinning records the Environment policy revision, Runtime and primary, plus each entry's directory ID, canonical source path, resolved effective path and edit mode. Pin repository identity, checkout choice and resolved base/HEAD SHAs per repository, with one slug per Session. Preserve these bindings on resume. Moving a root or reinstalling a Runtime must not silently bind existing sessions to different files.

### In-place concurrency and default-on worktrees (design only)

Runs on the **same canonical in-place directory are serialized through a queue**, Multica-style. Aliases resolving to the same directory share a lease. A Session using several in-place directories acquires all leases in stable canonical-path-sorted order to avoid deadlock. Hold leases through tool/subprocess activity and reconcile them after daemon restart; separate worktrees allow parallel checkouts. Cross-session ancestor/descendant paths are **not** hard-rejected for privacy. Sessions must not learn about each other; the in-place queue may still serialize the same real path (and, if needed, overlapping real paths) **silently** without cross-session awareness UI.

Edit mode is configured per Environment entry. Non-Git entries stay `in_place`; report missing Git/worktree capability rather than downgrading silently. Git entries default to a per-session managed worktree; explicit `in_place` / Use existing is the opt-out. This slice does not implement the worktree manager:

- Follow Backchat's [`prepare()` in worktree-manager.ts](https://github.com/openma-ai/backchat/blob/92f1bf3/src/main/worktree-manager.ts) and [workspace selection](https://github.com/openma-ai/backchat/blob/92f1bf3/docs/workspace-selection.md). Each Session instantiates its own managed workspace from the Environment worktree entries on the Runtime at `~/.oma/bridge/workspaces/<sessionShortId>/`, containing one worktree per distinct repository named `NN-<safeName(repoBasename)>` (`01-`, `02-`, ...). Validate destinations under this OMA-managed root; sanitize names and reject collisions.
- Dedupe repository identity using the real `--show-toplevel` and Git common directory, so sibling checkouts of the same repository count once. Environment entries in the same repository share one worktree; each entry's effective path is that worktree plus its relative path inside its source repository. Require consistent checkout/edit-mode choices for entries sharing a repository.
- Use the Environment branch slug template with one Session slug and branch name for the whole workspace, for example `oma/<shortId>/<slug>`, created in every managed repository. Environment `base_branch` refs are per repository, defaulting to current HEAD; resolve and pin SHAs. If the local branch already exists, check it out instead; an explicit base must be an ancestor of that branch. Record the checked-out HEAD and `createdBranchRepos`; only branches OMA created may ever be deleted, using `git branch -d`.
- Write an ownership manifest in the workspace directory: Session ID, canonical source directories, roots with source/effective paths, worktrees with `repoRoot/path/head/branch`, resolved bases and `createdBranchRepos`. Refuse reuse without a matching manifest or with different source directories; revalidate recorded paths and Git registration on reuse.
- Creation is all-or-nothing: do not start the agent until every entry is prepared. On failure, roll back worktrees created in this attempt, preserving pre-existing checkouts and branches. Use the autosave-before-removal path below for rollback too; retain ownership records and mark `cleanup_blocked` if safe removal fails.
- **Use existing:** the Environment may configure an existing checkout per repository, including the source checkout itself (in place), instead of creating a managed worktree. Apply local authorization and real-path containment checks to that checkout and map each entry's relative path into it. Treat it as in-place for leases and never claim cleanup ownership. No cross-repository conflict analysis is performed.
- Worktrees do not automatically receive dirty, untracked or ignored source files. Backchat rollback/removal uses `git worktree remove --force` plus `rm -rf`; OMA diverges by autosaving work to its owned branch before removing the worktree, including during rollback, under the ownership and force guards below.

### Archive and cleanup

OMA must reclaim session workspaces and sandboxes automatically so they cannot accumulate and fill the user's disk. Sandbox cleanup follows the retention and output-export policy above; idle timeout pauses or stops a sandbox without starting retention before archive. Runtime-level `worktree_retention_days` defaults to **30**, configured through `oma bridge config` or **Runtime settings** in Console. The worktree clock starts at Session archive, or at last activity for idle Sessions; renewed activity resets the idle clock. `0` means delete at archive. An optional `max_workspace_bytes` cap is shared by worktrees and sandbox containers, persisted volumes/snapshots and Session-only images. It triggers early eviction of the oldest archived Session resources first, using their respective cleanup paths. Running Sessions are never reclaimed. Report blocked reclamation when the cap cannot be met safely; Console reports reclaimed bytes.

Track archive/cleanup state per entry; remove a shared repository worktree only once, after all entries using it are released. At expiry, the daemon automatically deletes the OMA-managed Session workspace. Safety comes from preserving work in Git before removal. Never touch the user's source checkouts, in-place directories, existing/user-adopted checkouts or non-OMA branches. Console **Delete now** invokes this same path immediately:

1. Stop/reconcile OMA-owned processes and acquire a cleanup lease. Revalidate the ownership manifest, canonical path containment inside the managed root, Git registration and OMA-owned branch recorded in `createdBranchRepos`. Never target a source checkout or an active Session.
2. Check for staged, unstaged and untracked changes, locks, in-progress operations and nested repositories/submodules. Auto-commit uncommitted and untracked work to the OMA-owned branch with message `oma: autosave before cleanup`, respecting `.gitignore`. Ignored files are discarded as build/dependency output. If preservation cannot complete, including hook failures, locks or an in-progress rebase, mark `cleanup_blocked`, preserve the workspace and surface the reason in Console.
3. After successful preservation, run `git worktree remove <path>`. Force is acceptable only after the autosave commit succeeded, and only for a verified OMA-managed worktree inside the managed root. If ignored output requires force on an otherwise clean worktree, first create a successful autosave checkpoint commit (empty if needed). On removal failure, mark `cleanup_blocked`; do not use `rm -rf`, `git clean`, `reset --hard` or manual Git metadata surgery as a fallback. Run `git worktree prune` after removal and remove the empty Session workspace directory after all its worktrees are gone.
4. Keep each OMA-owned branch for the same `worktree_retention_days` window again, starting at workspace removal. At branch expiry, delete with `git branch -d` only if merged, using recorded integration/base information. Otherwise keep it and report a notice; branches cost almost nothing on disk. Never use `-D` or delete non-OMA branches.
5. If the Runtime is offline, leave cleanup pending and run overdue cleanup when it reconnects. Report archived, cleanup pending, `cleanup_blocked`, workspace removed and retained unmerged branch separately; allow retry after operator intervention.

### Comparison points from the source summary

The source summary (internal research note `oma-runtime-workdir-oss-comparison.md`) records documentation/source research, not product execution tests:

- Host then folder is a clear selection model: [Zed remote development](https://zed.dev/docs/remote-development) and [Cline SSH](https://github.com/cline/cline/blob/main/docs/usage/cline-desktop-ssh.mdx). [Goose](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/session/session_manager.rs) persists an explicit working directory. GitHub resources need not define it.
- [Multica local resources](https://github.com/multica-ai/multica/blob/7a12304f1473c71e0cee970c773246eaf96abc49/apps/docs/content/docs/project-resources.mdx) bind daemon + path + mode, support non-Git in-place folders, and serialize the same real directory. [Coder](https://github.com/coder/terraform-provider-coder/blob/main/docs/resources/agent.md) and [DevPod](https://devpod.sh/docs/developing-in-workspaces/create-a-workspace) primarily provision environments; neither establishes arbitrary host-folder authorization. [Conductor](https://www.conductor.build/docs/concepts/git-worktrees) explicitly distinguishes worktrees from a security boundary; its OSS implementation was unverified.
- Most examined OSS worktree managers force-delete: [OpenCode v1.2.21](https://github.com/anomalyco/opencode/blob/v1.2.21/packages/opencode/src/worktree/index.ts), [Claude Squad](https://github.com/smtg-ai/claude-squad/blob/main/session/git/worktree_ops.go), [Crystal](https://github.com/stravu/crystal/blob/main/main/src/services/worktreeManager.ts), [vibe-kanban](https://github.com/BloopAI/vibe-kanban/blob/main/crates/worktree-manager/src/worktree_manager.rs) and [Multica](https://github.com/multica-ai/multica/blob/7a12304f1473c71e0cee970c773246eaf96abc49/server/internal/daemon/execenv/local_worktree.go#L1051). OMA autosaves work before removal and limits force to verified managed worktrees after a successful autosave commit. Amp does not force-delete in the supplied baseline and was not independently audited in the summary. Crystal also initializes Git for plain folders, which OMA must avoid.
- [Raft lifecycle](https://docs.raft.build/features/agents/lifecycle/) separates archive keep/delete choices, but its [deletion source](https://github.com/botiverse/raft-source/blob/db5e399f017d584e49597e3a28757645d6807893/packages/daemon/src/workspaces.ts#L176) forces recursive removal. The summary verified Raft at raft.build, not identity with raft.dev. Versioned OSS findings do not establish current hosted-product parity.

### API / CLI / Console sketch (proposed)

Extend the Environment attachment rather than using Agent/GitHub paths as placement authority:

```json
{
  "config": { "type": "self_hosted" },
  "_oma": { "runtime": {
    "runtime_id": "rt_buildbox",
    "placement": "host",
    "directories": [
      { "directory_id": "dir_shop", "subpath": "src", "edit_mode": "worktree" },
      { "directory_id": "dir_notes", "edit_mode": "in_place" }
    ],
    "primary": 0,
    "repositories": [{ "directory_id": "dir_shop", "base_branch": "main" }],
    "branch_slug_template": "oma/<shortId>/<slug>",
    "env": { "NODE_ENV": "development" }
  }}
}
```

`directories[]` contains the Environment's selected authorized roots/subpaths and per-entry modes; `primary` selects the start cwd. An empty list with no primary chooses managed scratch for host mode. Sandbox uses no host directory IDs. `repositories[]` identifies each deduped repo through a configured directory ID; reject conflicting checkout options. `branch_slug_template` configures branch naming. Validate on Environment save and re-check at Session launch as specified above.

| Surface | Proposed shape |
|---|---|
| Runtime API | `GET /v1/oma/runtimes/:id` includes `owner_user_id`, capabilities and resources; `GET /v1/oma/runtimes/:id/directories` lists locally approved stable IDs, canonical paths, Git capability and policy revision |
| Directory approval | Console may create a pending request; only authenticated local workspace root approval/`allow-dir` commits authorization. No remote path-add endpoint grants access |
| Session API | Placement input is the Environment ID only, with an optional Session `slug` for branch naming. Return effective primary cwd, additional roots, per-entry pinned paths/modes and queue state, per-repo branches/base/HEAD SHAs and sandbox ID when applicable. Directory and checkout choices come from the Environment |
| Cleanup API | Archive starts retention; daemon expiry and Console Delete now share worktree autosave/removal or sandbox output export/removal as described above. Report reclaimed bytes. Report `pending`, `cleanup_blocked`, `removed` and retained unmerged branches; branch expiry follows a second retention window |
| Runtime cleanup config | `oma bridge config` / Console Runtime settings: `worktree_retention_days` (default 30; 0 deletes at archive), `sandbox_retention_days` (default 30; 0 cleans up at archive), shared optional `max_workspace_bytes` evicting oldest archived Session resources first, idle sandbox timeout and separate LRU image-cache size cap |
| Local CLI | `oma bridge allow-dir /srv/projects`, `oma bridge dirs list`; local revoke blocks new starts/resumes |
| Environment CLI | `oma env create --runtime <id> --placement host --directory <id>[:<subpath>][@worktree\|@in_place] [--directory …] --primary <index>`; `--directory` is repeatable. Sandbox uses `--placement sandbox` without directory flags |
| Session CLI | `oma sessions create --agent <id> --env <id> [--slug <slug>]`; starts from the Environment configuration |
| Console | Runtime shows owner, capabilities and authorized roots. The Environment editor owns Runtime, Sandbox/Host, directory/subpath picker, primary, per-entry edit modes, per-repo worktree/Use existing and base ref and branch slug template. Session view shows effective paths, branches and queue state; non-Git stays in place |

Console must state: **“Served directories pick the start cwd and additional workspace roots and are not a sandbox. Commands run with the Runtime user's permissions.”** A remotely requested new root remains pending until local workspace root approval. Archive starts automatic retention cleanup; show the expiry, shared disk cap, reclaimed bytes, Delete now action, autosave/output-export status and concrete cleanup blockers. Serving a plain folder never introduces a GitHub OAuth prerequisite.

## 5. Decisions and recommendations

Owner answers recorded 2026-11-05 (America/Detroit). Recommendations below for still-open items are based on T3 Code docs/source and peers (Multica, Backchat, Zed remote, Cline SSH, Amp); they are **proposals**, not owner locks, unless marked **Decided**.

### 5.1 Decided (owner)

1. **Workspace-centric permissions (was Q1 authorization half).** Permissions are workspace-centric, not user-centric. A shared Environment on someone’s Runtime is authorized via **workspace membership/grant**, not per-user ownership alone. Users may **clear state** from the machine or from Console. Pairing may still record `owner_user_id` for audit. Conflict on Agent `runtime_binding` vs Environment attachment remains **409**; migration/deprecation timing for Agent-level placement is still open (see §5.3).
2. **Git worktree default (was Q2).** Worktree is the **first-use default** for eligible Git entries; the Environment editor lets the user **cancel/opt out** (in_place / Use existing).
4. **Cross-session isolation (was Q4).** Do **not** refuse overlapping ancestor/descendant paths across Sessions for “privacy” reasons the owner did not ask for. Sessions should simply **not know about each other**: no cross-session directory awareness or coordination UI. Leases may still serialize the same (or overlapping) real path **silently** without sessions seeing each other. Crashed-lease / revoke-while-running mechanics stay implementation detail under that rule.
5. **Runtime-attached sandbox = LiteBox (was Q5 / OpenSandbox confusion).** Initial Runtime-owned sandbox backend is **LiteBox only**. LiteBox network targets the **local daemon**; the daemon contacts the OMA control plane. Cloud Environment `SANDBOX_PROVIDER=litebox` is a **different** control-plane path and must not be conflated. OpenSandbox Docker is **not** the Runtime-attached default. T3 research does not contradict this: T3 keeps filesystem/provider authority on the execution server ([internals/overview](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md)) and can SSH into a Docker sandbox as a normal host ([Docker docs](https://docs.docker.com/ai/sandboxes/integrations/t3-code/)); it does not define an OpenSandbox-on-Runtime product we must match.

### 5.2 Recommendations (research; awaiting owner)

#### Q3 — Path moves, symlink replacement, Windows casing/drives, removable mounts

**Recommend: pin identity, revalidate on use, never silent rebind.**

- Keep a stable `directory_id` plus recorded **canonical real path** (and, where available, volume/device identity). At Session launch/resume, resolve with realpath/EvalSymlinks and compare to the pin; on mismatch mark the entry **stale** and require re-authorization or an explicit rebind — do not silently follow a moved/replaced path into different files.
- **Symlinks:** resolve before authorize, lease, and contain checks. Multica validates the real path and applies the serial lock to that real path, including when two symlink spellings meet ([project resources](https://github.com/multica-ai/multica/blob/7a12304f1473c71e0cee970c773246eaf96abc49/apps/docs/content/docs/project-resources.mdx)). Match that for OMA leases and pins.
- **Windows:** normalize casing and `\?\` / drive-letter forms before compare; reject traversal tricks (T3 `WorkspaceFileSystem` realpath + NTFS trailing-dot/short-name hardening is a useful bar — [source](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/workspace/WorkspaceFileSystem.ts)). Prefer junctions or documented fallbacks already used by the skill cache when symlinks fail.
- **Removable / relocated mounts:** if the volume is absent, **fail launch** with a clear “path unavailable” error and keep the pin; when the same volume identity returns, resume. Do not drop pins because a mount disappeared.
- **Managed workspace root:** validate destinations under the OMA-managed root after realpath; T3 allows relocating the worktree folder per machine while leaving existing worktrees in place ([project-settings → Worktree location](https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md)). OMA can allow a configured managed-root path the same way without rewriting old Session pins.
- Peers: Zed/Cline keep an explicit host then folder model ([Zed remote](https://zed.dev/docs/remote-development), [Cline SSH](https://github.com/cline/cline/blob/main/docs/usage/cline-desktop-ssh.mdx)); Backchat discovers repos without following child symlinks ([workspace-selection](https://github.com/openma-ai/backchat/blob/92f1bf3/docs/workspace-selection.md)).

#### Q5b — LiteBox validation gates (live certification deferred beyond M1)

**Recommend: capability probe on the daemon; gate the Environment editor and Session start on reported capabilities.**

T3 does not define LiteBox gates. Use OMA’s existing adapter + receipts:

| Gate | Requirement |
|---|---|
| Package | `@boxlite-ai/boxlite` loads on the daemon host |
| Hypervisor | Native runtime present (BoxLite/Firecracker/libkrun/KVM as required on that OS); otherwise report unsupported and offer BoxRun only if configured |
| Smoke | Create VM → `mkdir`/`exec` in `/workspace` succeeds (same class of check as local LiteBox receipts under `docs/screenshots/498/receipts/litebox-local/`) |
| Resources | Honor `LITEBOX_MEMORY_MIB` / `LITEBOX_CPUS` / image; fail closed if over host capacity |
| Networking | Guest egress policy matches Runtime credential/egress story; LiteBox talks to **local daemon**, daemon to control plane (owner) |
| Heartbeat | Runtime status advertises `sandbox_modes: ["litebox"]` only after gates pass; Console disables Sandbox placement otherwise |

Separate **Cloud** `SANDBOX_PROVIDER=litebox` (Node control plane) from **Runtime-attached** LiteBox in UI copy and capability bits so operators are not confused by the #498 CF Containers vs litebox-local split.

#### Q6 — Submodules / nested / LFS / unborn / bare during autosave; `cleanup_blocked` UX

**Recommend: preserve-or-block; never force-delete past a failed autosave.**

- **Submodules:** on managed worktree create, initialize submodules **recursively by default**, with Environment/Runtime overrides for top-level-only or skip — same shape as T3 ([project-settings](https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md)). Autosave commits inside the OMA-owned worktree; if a submodule is dirty in a way autosave cannot commit, mark `cleanup_blocked` with code `submodule_dirty`.
- **Nested repositories:** detect before autosave/remove; do not recurse deletes into nested roots; `cleanup_blocked` with `nested_repo`.
- **LFS:** if `git lfs` is required to materialize or commit preserved content and is missing/fails, `cleanup_blocked` with `lfs_unavailable` rather than dropping pointers/content.
- **Unborn / bare:** reject `worktree` edit mode at Environment validate and at launch (Multica requires a git repo with at least one commit for worktree mode). Autosave on bare/unborn → `cleanup_blocked` / `unsupported_git_state`; prefer `in_place` only when the user explicitly chose it for a non-bare checkout.
- **`cleanup_blocked` Console UX:** show structured reason codes, human text, path, Session id, **Retry cleanup**, and **Open on machine** hints. Surface disk-cap pressure and retained unmerged branches as separate notice types (already sketched in Archive and cleanup). T3 cleanup results list removed/kept/why and never remove unused folders blindly ([project-settings Cleanup](https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md)); Multica keeps the worktree when commit/save cannot complete ([local_worktree leftovers](https://github.com/multica-ai/multica/blob/7a12304f1473c71e0cee970c773246eaf96abc49/apps/docs/content/docs/project-resources.mdx)). Align OMA with preserve-or-block.

#### Q7 — Overlay secrets: seal vs vault; per-user/per-Runtime; daemon consumption

**Recommend: sealed Environment `secret_env` + vault references; children only; no per-user overlay in M2.**

- **Seal** write-only Environment `secret_env` with the existing session-secrets sealer keyed by Environment (names on GET). Prefer **vault `command_secret` references** for long-lived / shared secrets operators already rotate in vault.
- Precedence stays **session env resources > Environment overlay > daemon process env** (Amp-style; Amp’s `--amp-env` injects Secrets & Env into the thread shell / stdio MCP, not into a system daemon — [Amp runners](https://ampcode.com/docs/cli/runners)).
- **Do not** inject Environment overlays into the daemon process itself. Machine-local daemon knobs (PATH, proxy, feature flags) belong in a local file akin to T3 `~/.t3/service.env` ([background-service](https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md)), chmod-restricted, surviving updates, applied on daemon restart only.
- **Per-user overlays:** defer. Owner chose workspace-centric permissions; a personal layer would reintroduce user-centric policy. Revisit only if Amp-like personal > project > workspace is explicitly wanted later.
- **Per-Runtime overlays:** optional later for host-specific non-secret vars; not required for M2 if `service.env`-style local config covers daemon needs.

#### Q8 — Pairing token TTL / rotation / audit; secure automation input

**Recommend: keep OMA’s 1h default; hash + revoke; prefer env/file over argv.**

| Concern | Recommendation | T3 / peer citation |
|---|---|---|
| Bootstrap TTL | Keep API range **300s–24h**, default **1h** (GitHub registration-token class). Offer a Console preset for **5m** for tight interactive paste | T3 `t3 pair --ttl` default **5 minutes**, examples `5m`/`1h` ([pair.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/cli/pair.ts)); OMA already documented 1h default |
| One-time | Single-use exchange (already) | T3: fresh one-time link per device ([remote-access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)) |
| List / revoke | Phase 2 pending-token list + revoke; store **sha256(code)** only; separate revoke of unused bootstrap vs established `sk_machine_*` | T3 separates unused pairing link revoke vs session revoke ([remote-access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md), [environment-auth](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md)); read model never returns recoverable secrets |
| Long-lived analogues | Do not silently turn bootstrap tokens into 30-day credentials; machine token rotation is a distinct flow | T3 Connect / cross-environment links last **30 days** and renew with a new pairing code ([remote-access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)); guest links **24h** ([guest-links](https://github.com/pingdotgg/t3code/blob/main/docs/user/guest-links.md)) |
| Audit | Emit mint / exchange success / exchange replay reject / expire / revoke events with actor, Runtime, workspace | Matches T3’s explicit revoke surfaces and non-recoverable metadata |
| Secure automation | Prefer `OMA_PAIRING_TOKEN` env (exists) or `--token-file` / `file:` style; discourage raw `--token=` on shared shell history; document `HISTCONTROL`/CI secret stores | Tailscale `file:` auth-key form; T3 prints QR/URL once and does not re-show secrets from the connections list |

Device authorization + loopback PKCE remain the decided interactive flows (§3d).

#### Q9 — CMA `/work` dual-serve vs reject; standalone packaging / update channel

**Recommend: reject dual-serve for Runtime-attached Environments; detect install channel for updates; ship install script → binary after npx.**

- **Dual-serve:** Runtime-attached (`_oma.runtime`) Environments must **not** be claimable by unmodified CMA `/work` pollers. Queue consumption for those Environments belongs to the **paired Runtime bridge**. Cloud / non-attached Environments keep today’s worker poll path. Showing attached Environments to stock CMA workers invites double claim and split-brain; reject or filter at enqueue/claim time rather than “visible but hope workers ignore.”
- **Packaging / updates (T3 lesson):** treat channels separately — temporary `npx`, installed CLI/binary, OS service, future desktop — and refuse incompatible protocol pairs rather than half-upgrading ([install](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md), [updating](https://github.com/pingdotgg/t3code/blob/main/docs/user/updating.md), [server-updates](https://github.com/pingdotgg/t3code/blob/main/docs/internals/server-updates.md)).
- **Ship order for OpenMA:** keep `npx @openma/cli` now → Phase 3 **origin-aware `install.sh` / `install.ps1`** pinning a CLI version (T3’s first-class path) → single-file binary + brew/winget. Console upgrade actions must name the machine and detected channel; service restart stays explicit.

### 5.3 Still open (need owner or later ADR)

- Migration schedule: when Agent `runtime_binding` / GitHub `local_path` stop being placement authorities after Environment authority ships (409-on-conflict is already assumed).
- Exact crashed-lease recovery timeouts and whether revoking a directory force-stops running Sessions or only blocks new starts/resumes (under the silent-lease rule).
- Whether per-Runtime `service.env`-style files are in M2 or M3.
- Platform matrix for LiteBox gates (macOS/Windows/Linux CI) before advertising Sandbox placement GA.

---

## Appendix: files touched by the M1 slice

- API types: `packages/api-types/src/runtime-pairing.ts` (+ `index.ts` export)
- Environment extension: `packages/managed-agents-domain/src/environments/environment.ts`, `packages/managed-agents-application/src/{ports,environments}/…`, `packages/managed-agents-api/src/{contracts,mappers}/environments.ts`
- Server: `apps/main/src/routes/runtimes.ts` (pairing-tokens route, `runtimeEnvironmentOverlay`, bundle merge)
- CLI: `packages/cli/src/bridge/lib/pairing.ts`, `bridge/commands/setup.ts`, `src/index.ts` (`runtime pair`, `--token`, help), `.changeset/runtime-headless-pairing.md`
- Console: `src/lib/env-overlay.ts`, `src/components/RuntimeAttachmentFields.tsx`, `src/pages/{EnvironmentsList,EnvironmentDetail,RuntimesList}.tsx`, `src/lib/managed-api.ts`
- Tests: `packages/managed-agents-api/test/environments-runtime-attachment.contract.test.ts`, `packages/managed-agents-application/test/environments-application.test.ts`, `test/integration/runtimes-route.test.ts`, `packages/cli/test/pairing.test.ts`, `apps/console/src/lib/env-overlay.test.ts`, `apps/console/src/pages/EnvironmentDetail.runtime.test.tsx`
