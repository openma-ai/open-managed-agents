# Runtime discovery, download, pairing and selection: design memo

Status: **Draft** (2026-11-04) · Branch `draft/runtime-download-selection`
Issues: [#449](https://github.com/openma-ai/open-managed-agents/issues/449) (Amp-style env+secrets overlay), [#415](https://github.com/openma-ai/open-managed-agents/issues/415) (Console product-surface gaps)
Related: [ADR 0005](../adr/0005-self-hosted-worker-runtime-resources.md), [v1-architecture](../v1-architecture.md), [archive/external-agent-runtime](../archive/external-agent-runtime.md)

**Question.** How do users discover, download, install and pair the local runtime, and how do they choose and configure a runtime from the Console and from the CLI?

**Owner decisions this memo follows.**

1. One machine is one **Runtime**. A Runtime is a peer API resource to Environment (`/v1/oma/runtimes`) and is never nested under it.
2. A **Runtime** pairs the whole machine once (identity and connection), owned by one user (`owner_user_id`). It reports Git, Docker, supported sandbox modes and available resources. An **Environment** binds a Runtime and chooses placement rules; a **Session** selects within those rules, and the daemon re-validates locally. Cloud-provisioned Environments remain available separately.
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

**What carries over to OpenMA:**

- **Separate interactive and unattended pairing.** Browser loopback + PKCE serves machines with a browser; RFC 8628 device authorization serves headless interactive use. A short-lived, single-use pairing command remains a bootstrap fallback, following GitHub registration tokens and Tailscale one-off keys. Existing loopback and token support do not yet implement the full target.
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
| `Environment._oma.runtime { runtime_id, env }` | **Implemented** across domain, application, contract and mapper | Current schema allows attachment only on `self_hosted` and rejects cloud + runtime. This is an existing schema constraint, not the target placement rule: a Runtime can own a local sandbox. Extend the attachment with placement fields described below. Env names must match `[A-Za-z_][A-Za-z0-9_]*`. The write replaces the whole attachment, `null` detaches, and it is omitted on the wire when unset (the official SDK still parses it). Stored in the existing `document` JSON, so no migration. |
| Bundle merges the Environment overlay | **Implemented** | `GET /agents/runtime/sessions/:sid/bundle` reads the session's Environment. The overlay is served **only if** the Environment is live and `_oma.runtime.runtime_id` equals the authenticated runtime. Session `env` resources override it by name. |
| `_oma.runtime.secret_env` (write-only names → sealed values) | Phase 2 | Reuse the `session-secrets-store` sealing (`CfManagedSessionSecretSealer`) keyed by environment. GET returns names only. Alternatively, reference vault credentials of type `command_secret`. |
| Session placement from the Environment | Phase 2 | When `environment._oma.runtime` is set, session create derives `runtime_binding.runtime_id` from it and needs only the ACP agent from the Agent. If the Agent already has a different `runtime_binding`, reject with 409 rather than guess. |
| `GET /v1/oma/runtimes/:id`, `PATCH {name, labels}` | Phase 2 | Display name and labels (Buildkite-style tags) for picker filtering and future pools. |
| Pending pairing-token list + revoke | Phase 2 | `GET/DELETE /v1/oma/runtimes/pairing-tokens`. Store a `sha256(code)` instead of the plaintext code; the existing browser flow stores plaintext. |
| Runtime ownership | Decided | One user owns each Runtime (`owner_user_id`). Pairing, Environment attachment and directory authorization must respect that identity; workspace membership alone grants no machine access. |

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
| Environment placement editor and Session directory picker | Proposed: sandbox/host, default/custom directories, allowed edit modes; only locally authorized roots and their subpaths |
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
| Phase 2 | `curl -fsSL https://<host>/install.sh \| sh -s -- --token=omrp_…`, a thin script that checks for Node and runs a pinned `npx @openma/cli@<ver>`. The Console renders it with the deployment's own origin, which matters for self-hosters. |
| Phase 3 | Single-file binaries (Node SEA or bun-compile) on GitHub Releases plus a Homebrew tap and winget. The daemon reports `version` (already in `runtimes.version`) and the Console flags outdated runtimes. `oma bridge upgrade` updates the binary. |

### 3f. Milestones

- **M1 (this draft):** headless pairing (API, CLI, Console), Environment `_oma.runtime` + env overlay (API, Console create and edit), overlay delivered to the daemon bundle, tests.
- **M2:** Environment-authoritative placement and local directory grants, Runtime-owned OpenSandbox, in-place queues and safe worktrees, loopback PKCE and device authorization, sealed `secret_env`, runtime display name and labels, Runtime detail page, pending-token revoke, hashed codes, `oma env` CLI verbs.
- **M3:** install script, standalone binary + update check, additional sandbox backends and optional host confinement. Any fleet/pool design must preserve explicit user ownership and machine-local directory authorization.

---

## 4. What users can actually use in this first draft

**Works end to end:**

- Pair a headless machine. Run `oma runtime pair` or use Console → Generate pairing command, then paste the command on the machine. It shows up in `oma runtime list` and on `/runtimes`. Covered by an integration test against the real worker + D1: minted token → `/exchange` succeeds once, a replay gets 400 "code already used", and bad TTLs and anonymous callers are rejected.
- Create or edit a `self_hosted` Environment attached to a Runtime, with an env overlay, from the Console or the API. The current API enforces the cloud/attachment schema constraint and valid env names. Local sandbox placement on a Runtime still needs the extension below.
- The daemon receives the overlay in the session bundle and exports it into the spawned ACP agent's process env (so its shell, stdio MCP servers and plugins inherit it). This happens only when the session's Environment is attached to **that** runtime. Session `env` resources win on conflicts.

**Not yet (be explicit with users):**

- **Attaching an Environment does not route sessions to the machine yet.** Routing still comes from the Agent (`harness: acp-proxy` + `runtime_binding`). For the overlay to apply today, the session must use an Agent bound to the same runtime **and** the attached Environment. M2 makes the Environment authoritative.
- I did not verify end to end that `session.environment_id` is populated on the session record the bundle route reads for every session-creation path. That needs a live check, and the overlay silently degrades to "none" if it is missing.
- The overlay holds **plain values only**, and workspace members can read them through `GET /v1/environments/:id`. Secrets should keep using vaults or session `env` resources until `secret_env` lands.
- Runtimes are still owned by one user. Another workspace member can't pick your machine, and the picker lists only *your* runtimes. An Environment pointing at a colleague's runtime shows as "revoked or not yours".
- No pending-token list or revoke. Unused tokens expire, by default after 1 hour.
- Node ≥ 20 is required on the target machine (npx). There is no standalone binary yet.

---

## Session placement: sandbox vs host, default vs custom directories

### Layers and placement choices

Pair the **whole machine once**, independent of folders or GitHub. The Runtime reports Git present, Docker present, supported sandbox modes, resources and online status. The Environment binds `runtime_id` and defines allowed placement, directories and edit modes. A Session chooses within that policy. The daemon checks capabilities, current policy and real paths immediately before launch/resume, rejecting unavailable or out-of-bounds choices without silently falling back to scratch or in-place editing.

The two axes are **sandbox or host** and **custom directory or default directory**. There are three effective combinations; custom host directories are never mounted into sandbox mode.

| Placement | Files and execution | Resource injection |
|---|---|---|
| Sandbox | Independent container/microVM on the Runtime machine's own resources; no host directory mounts | Files arrive through resources, e.g. clone a GitHub repository inside the sandbox |
| Host, default directory | Today's per-session scratch directory `~/.oma/bridge/sessions/<12hex>/` | GitHub repository and other resource injection remain allowed |
| Host, custom directories | Multiple served directories, Git or non-Git; edit in place or optionally use a Git worktree | No GitHub repository resource injection, avoiding duplicate copies and ambiguous cwd; an optional Git credential (token) alone may enable push/PR |

Initial sandbox implementation reuses **self-hosted OpenSandbox with its Docker backend**. OMA already has an OpenSandbox provider; register each resulting sandbox as owned by that Runtime. Later backend candidates: Apple Containerization or Lima on macOS, Firecracker on Linux, and Microsoft LiteBox on Windows. LiteBox is MIT-licensed and has a Linux-on-Windows userland runner; it is early/unstable and toolchain support is unverified.

Lightweight OS-level confinement (Seatbelt/bubblewrap, e.g. Codex `workspace-write` and Claude Code `sandbox-runtime`) is optional future **host-mode hardening**, not sandbox mode. Served directories select the start directory; they do not confine commands. Worktrees separate checkouts and branches, not process permissions.

### Runtime-local directories and authorization

Today `acpSessionStartCwd` is set only from `agent.runtime_binding` through `resolveRepositoryLocalPath`, using a `github_repository` resource's `local_path` (see `apps/agent/src/runtime/session-do.ts` around L6369 and `apps/agent/src/harness/acp-proxy-delivery.ts`). Otherwise the daemon uses scratch. This couples execution location to GitHub metadata.

Replace that coupling with a **Runtime-local path and stable `directory_id`**. Detect Git locally through `.git` (directory or worktree file); any remote or no remote is valid. Non-Git folders are first-class, edited in place and never automatically initialized with Git. Repository metadata is optional integration/provenance, not directory identity.

Only the machine owner can authorize custom roots: `oma bridge allow-dir <path>`, or a **local confirmation prompt** the first time Console references a path. Remote clients may request approval but cannot add authorized paths themselves. Runtime ownership is one `owner_user_id`; Environment visibility or remote API access does not bypass local approval.

An authorized root authorizes its **whole subtree**. Session requests use `directory_id` plus optional relative `subpath`; any descendant can be chosen without separate authorization. The daemon resolves the root and requested path to real paths, including symlinks and `..`, and rejects anything outside that authorized root. Check containment by path components, revalidate before execution, and reject stale/revoked roots. Console browsing stays within authorized roots.

Pin Runtime, directory ID, policy revision, canonical source path, effective cwd and edit mode on the Session. Preserve that binding on resume. Moving a root or reinstalling a Runtime must not silently bind existing sessions to different files.

### In-place concurrency and optional worktrees

Runs on the **same canonical in-place directory are serialized through a queue**, Multica-style. Aliases resolving to the same directory share the queue. Hold the lease through tool/subprocess activity and reconcile it after daemon restart; separate worktrees allow parallel checkouts. Overlapping ancestor/descendant directories need a conflict policy (see open questions).

For a Git directory, the Session may optionally create a per-session worktree:

- Sibling path: `<repo>-oma-<slug>-<shortSessionId>`; branch: `oma/<shortSessionId>/<slug>`.
- Record base branch and resolved base SHA, source repository identity, generated path, and explicit OMA ownership of the worktree and branch. Sanitize names and reject collisions.
- A sibling is outside the repository root. Local owner approval must explicitly authorize a daemon-managed sibling worktree destination policy, or the owner must authorize a containing root. Compute and validate destinations locally; never accept arbitrary sibling paths from clients or grant general sibling access implicitly.
- A worktree starts at the recorded commit. Do not automatically transfer dirty, untracked or ignored files. Non-Git folders support only `in_place`; report missing Git/worktree capability rather than downgrading silently.

### Archive and cleanup

Archiving the session and deleting files are separate operations. **Default: keep worktree and branch.** Never delete the original served directory. Cleanup requires an explicit request for OMA-owned artifacts and follows the same rules for manual actions and future retention jobs:

1. Stop/reconcile OMA-owned processes and acquire a cleanup lease. Revalidate ownership, path identity and Git registration; never target the main checkout or a user-adopted directory.
2. Preflight staged, unstaged, untracked **and ignored** files, nested repositories/submodules, locks and in-progress operations. Return blockers and recheck at execution time; a clean status alone is insufficient.
3. Use plain `git worktree remove <path>` only. On refusal, preserve files and record `cleanup_blocked`. No force, `rm -rf`, `git clean`, `reset --hard`, recursive deletion fallback or manual Git metadata surgery.
4. Keep the branch unless separately requested. Delete only an OMA-created branch, using `git branch -d` and recorded integration/base information; never `-D`.
5. If Runtime is offline, leave cleanup pending. Report archived, cleanup pending, cleanup blocked and removed separately; allow retry after owner intervention.

### Comparison points from the source summary

The source summary (internal research note `oma-runtime-workdir-oss-comparison.md`) records documentation/source research, not product execution tests:

- Host then folder is a clear selection model: [Zed remote development](https://zed.dev/docs/remote-development) and [Cline SSH](https://github.com/cline/cline/blob/main/docs/usage/cline-desktop-ssh.mdx). [Goose](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/session/session_manager.rs) persists an explicit working directory. GitHub resources need not define it.
- [Multica local resources](https://github.com/multica-ai/multica/blob/7a12304f1473c71e0cee970c773246eaf96abc49/apps/docs/content/docs/project-resources.mdx) bind daemon + path + mode, support non-Git in-place folders, and serialize the same real directory. [Coder](https://github.com/coder/terraform-provider-coder/blob/main/docs/resources/agent.md) and [DevPod](https://devpod.sh/docs/developing-in-workspaces/create-a-workspace) primarily provision environments; neither establishes arbitrary host-folder authorization. [Conductor](https://www.conductor.build/docs/concepts/git-worktrees) explicitly distinguishes worktrees from a security boundary; its OSS implementation was unverified.
- Most examined OSS worktree managers force-delete: [OpenCode v1.2.21](https://github.com/anomalyco/opencode/blob/v1.2.21/packages/opencode/src/worktree/index.ts), [Claude Squad](https://github.com/smtg-ai/claude-squad/blob/main/session/git/worktree_ops.go), [Crystal](https://github.com/stravu/crystal/blob/main/main/src/services/worktreeManager.ts), [vibe-kanban](https://github.com/BloopAI/vibe-kanban/blob/main/crates/worktree-manager/src/worktree_manager.rs) and [Multica](https://github.com/multica-ai/multica/blob/7a12304f1473c71e0cee970c773246eaf96abc49/server/internal/daemon/execenv/local_worktree.go#L1051). Amp does not force-delete in the supplied baseline; OMA follows that never-force behavior. Amp was not independently audited in the summary. Crystal also initializes Git for plain folders, which OMA must avoid.
- [Raft lifecycle](https://docs.raft.build/features/agents/lifecycle/) separates archive keep/delete choices, but its [deletion source](https://github.com/botiverse/raft-source/blob/db5e399f017d584e49597e3a28757645d6807893/packages/daemon/src/workspaces.ts#L176) forces recursive removal. The summary verified Raft at raft.build, not identity with raft.dev. Versioned OSS findings do not establish current hosted-product parity.

### API / CLI / Console sketch (proposed)

Extend the Environment attachment rather than using Agent/GitHub paths as placement authority:

```json
{
  "config": { "type": "self_hosted" },
  "_oma": { "runtime": {
    "runtime_id": "rt_buildbox",
    "placement": "host",
    "directories": ["dir_shop", "dir_notes"],
    "default_directory": "dir_shop",
    "edit_mode": "in_place",
    "env": { "NODE_ENV": "development" }
  }}
}
```

`placement: sandbox|host`; `directories[]` restricts the locally authorized roots available to the Session; `default_directory` selects one of them. An empty list and null default choose managed scratch for host mode. Sandbox uses no host directory IDs. `edit_mode: in_place|worktree` supplies the default; any permitted Session override must be bounded explicitly by Environment policy and local capabilities. Reject incompatible combinations, including non-Git worktree and custom directories plus GitHub repository injection.

| Surface | Proposed shape |
|---|---|
| Runtime API | `GET /v1/oma/runtimes/:id` includes `owner_user_id`, capabilities and resources; `GET /v1/oma/runtimes/:id/directories` lists locally approved stable IDs, canonical paths, Git capability and policy revision |
| Directory approval | Console may create a pending request; only authenticated local owner confirmation/`allow-dir` commits authorization. No remote path-add endpoint grants access |
| Session API | Existing create endpoint takes Environment plus `_oma.placement { directory_id, subpath?, edit_mode?, base_branch?, slug? }`; directory ID identifies an authorized root and subpath is relative. Return effective cwd, branch/base SHA, queue status and sandbox ID when applicable |
| Cleanup API | Archive keeps files; separate preview and cleanup actions report `pending`, `cleanup_blocked` or `removed`; branch deletion is separate |
| Local CLI | `oma bridge allow-dir /srv/projects`, `oma bridge dirs list`; local revoke blocks new starts/resumes |
| Environment CLI | `oma env create --runtime <id> --placement host --directory <id> --default-directory <id> --edit-mode in_place`; sandbox uses `--placement sandbox` without directory flags |
| Session CLI | `oma sessions create --agent <id> --env <id> --directory <directory_id> [--subpath app] [--edit-mode worktree --base-branch main]`; explicit scratch/sandbox follows Environment policy |
| Console | Runtime shows owner, capabilities and authorized roots. Environment selects Runtime, Sandbox/Host, then default/custom directories and edit mode. Session lists permitted roots/subpaths, Git worktree option, effective cwd and queue state; non-Git stays in place |

Console must state: **“Served directories pick the start directory and are not a sandbox. Commands run with the Runtime user's permissions.”** A remotely requested new root remains pending until local owner approval. Archive defaults to Keep files, and cleanup displays concrete blockers. Serving a plain folder never introduces a GitHub OAuth prerequisite.

## 5. Open questions

1. How should existing Agent `runtime_binding` and GitHub `local_path` sessions migrate to Environment authority? Keep a 409 on conflicting bindings; decide when to deprecate Agent machine placement.
2. How should Environment policy express allowed Session edit-mode overrides, and should Git worktrees be the first-use default or an explicit choice?
3. What local approval UX authorizes generated sibling worktrees without granting unrelated sibling access? How are path moves, symlink replacement, Windows casing/drives and removable mounts reconciled?
4. Should the in-place queue also lock overlapping ancestor/descendant directories? How are crashed leases and background processes reconciled, and does revoking a root stop existing runs?
5. What OpenSandbox lifecycle, networking, resource limits and credential policy apply on each Runtime? What toolchain validation gates future backends, particularly LiteBox?
6. How should ignored artifacts, submodules, LFS, hooks and unborn/bare repositories affect worktree setup and cleanup? What retention and disk-pressure notices preserve the never-force rule?
7. Seal overlay secrets or reference vaults? Add per-user/per-Runtime overlays beyond session > Environment > daemon precedence? Should overlays reach the daemon itself?
8. What fallback pairing-token TTL limits, rotation and audit events are needed? Device code and loopback PKCE are decided flows; secure automation input remains to specify.
9. Should attached Environments be visible to unmodified CMA workers polling `/work`, or reject dual-serving? Which standalone packaging format and update channel should ship first?

---

## Appendix: files touched by the M1 slice

- API types: `packages/api-types/src/runtime-pairing.ts` (+ `index.ts` export)
- Environment extension: `packages/managed-agents-domain/src/environments/environment.ts`, `packages/managed-agents-application/src/{ports,environments}/…`, `packages/managed-agents-api/src/{contracts,mappers}/environments.ts`
- Server: `apps/main/src/routes/runtimes.ts` (pairing-tokens route, `runtimeEnvironmentOverlay`, bundle merge)
- CLI: `packages/cli/src/bridge/lib/pairing.ts`, `bridge/commands/setup.ts`, `src/index.ts` (`runtime pair`, `--token`, help), `.changeset/runtime-headless-pairing.md`
- Console: `src/lib/env-overlay.ts`, `src/components/RuntimeAttachmentFields.tsx`, `src/pages/{EnvironmentsList,EnvironmentDetail,RuntimesList}.tsx`, `src/lib/managed-api.ts`
- Tests: `packages/managed-agents-api/test/environments-runtime-attachment.contract.test.ts`, `packages/managed-agents-application/test/environments-application.test.ts`, `test/integration/runtimes-route.test.ts`, `packages/cli/test/pairing.test.ts`, `apps/console/src/lib/env-overlay.test.ts`, `apps/console/src/pages/EnvironmentDetail.runtime.test.tsx`
