# Managed guest execution privileges

The managed guest policy is an ordinary default user with functional
passwordless sudo (owner decision t2043u, 2026-11-13). Guest root is not host
root. Provider VM/container isolation, host permissions, network restrictions,
Work/Session fencing and credential custody outside the guest remain unchanged.
Do not enable privileged containers or weaken an outer host policy to satisfy
this contract.

## Official E2B template and launch path

`packages/sandbox-adapter-e2b/template/template.mjs` installs the real sudo
package and a root-owned0440 `/etc/sudoers.d/oma-worker` rule for **only**
`oma-worker`: `ALL=(ALL:ALL) NOPASSWD: ALL`. Build validation runs visudo and
checks nonzero default UID followed by `sudo -n id -u` returning0. This enables
all commands inside this guest for that identity, not merely an id command.

SDK tools select `oma-worker` in `E2BSandboxExecutor`. In-sandbox harnesses use
the native management launcher, common NodeSpawner, `agent-spawner.mjs` and
`agent-exec.py`. The helper drops all real/effective/saved UID/GID values and
supplementary groups and replaces the child environment. It does **not** set
no_new_privs or empty the provider's capability bounding set. Effective,
permitted and ambient capabilities are cleared by the ordinary UID transition;
explicit sudo is required to regain guest root. Direct unprivileged setuid(0)
is still refused.

The helper fails explicitly if inherited no_new_privs or a bounding set missing
CAP_SETUID/CAP_SETGID makes sudo impossible. It also executes the actual
`sudo -n id -u` after the UID transition, catching missing policy/binary, nosuid
mounts or other outer restrictions before starting a harness. It never clears
seccomp, changes host capabilities, changes the default user to root, or
silently accepts a decorative sudo installation. Outer restrictions cannot
always be undone; an incompatible provider configuration must be reported.

## Security consequences

Guest filesystem ownership remains useful for accidental-write prevention and
ordinary default execution. It is **not** isolation from an agent that invokes
sudo. Guest root can inspect/modify the management daemon, process environments,
private rclone control sockets, guest-resident tokens, and readonly file copies.
Source-pin verification is an installation integrity check, not protection from
a guest root adversary after launch. Environment filtering and closed inherited
file descriptors still prevent accidental credential/lock inheritance; they do
not make guest-resident secrets inaccessible to guest root.

No additional credentials are sent to the guest by this policy. Vault secrets
kept in the host/provider injector remain outside it. Any existing credential
that is placed in a guest process (including storage management) must be treated
as available to guest root. Do not claim a required secret-hiding boundary using
only guest UID, mode0700, or environment filtering. Enforcement that must resist
the guest belongs outside its root domain. Server-side Work and Session authority
checks, output/memory publication fencing, mandatory persistence and tool-error
semantics remain required; sudo does not transfer scheduling ownership to a
Session or make a failed upload successful.

Readonly copy-sync Memory still is not written back by the host, even if guest
root edits the copy. A readonly FUSE mount initially rejects writes, but guest
root may interfere with mounts; do not advertise mount/UID protection as a
boundary against guest root. The same caution applies to in-guest advisory
network proxies; this change grants no new external network authorization.

## Verified scope and limitations

- Node/E2B and CF/E2B share the template, ordinary executor identity, and E2B
  harness-spawner implementation. A real fresh E2B guest gate checks tools and
  the production management-launcher/common-spawner/helper chain, actual sudo,
  stdin/stdout, UID/capabilities/NNP, and inherited-restriction rejection.
- This gate runs the official image provisioning command in a fresh validation
  fixture. A newly published complete template and deployment are separate
  review/acceptance gates. It does not certify a frozen older image or execute
  a paid model/complete upstream ACP conversation.
- CF Containers use their own Sandbox SDK/image path, not this E2B helper.
  `apps/agent/Dockerfile` installs sudo but declares no ordinary USER or managed
  sudoers rule; a package label alone does not prove this policy. The inherited
  image and SDK execution identity/capability contract need a separate actual
  provider gate. Current CF public security-block1010 prevents claiming that
  validation; do not bypass it or silently change privileged container flags.
- Local subprocess execution has no guest/host boundary. Never install this
  guest sudoers policy on the control-plane host. Docker/other custom providers
  need their own ordinary-user and functional-sudo evidence; no generic success
  is inferred from the E2B result.

Reproducible explicit provider gate:
`apps/main-node/node_modules/.bin/tsx packages/sandbox-adapter-e2b/test/guest-sudo.provider.mts`.
Supply only approved task credentials through secured environment,
`OMA_E2B_TEMPLATE`, and `OMA_SUDO_RECEIPT`. `OMA_AGENT_EXEC_SOURCE` may select a
retained old helper for RED; it does not modify the product source or a deployed
image. The gate records every new owned sandbox and pauses it at completion.
