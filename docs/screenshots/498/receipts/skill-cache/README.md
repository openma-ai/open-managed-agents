# Unified skill cache evidence — PR #498

Implemented host-runtime cache, verified against the live Cloudflare PR lane on
**Linux x64**, not botty Mac. The previous botty pairing receipts in `../botty/`
do not prove this new cache code ran on the Mac.

- [`linux-live.json`](linux-live.json): real Skills API upload/update, two Agents,
  one Attach-Runtime Environment and four idle Sessions; applies real authenticated
  bundles through the same functions used by both daemon preparation paths.
- [`filesystem.txt`](filesystem.txt): cache directory listing, session `readlink`
  and `stat` output. Sessions A/B share the same concrete target and inode.
- [`worker-observations.json`](worker-observations.json): filtered `wrangler tail`
  observations from the deployed bundle route; request headers omitted.
- [`botty-blocker.txt`](botty-blocker.txt): actual remote access failure. No Mac
  sync, daemon replacement or Mac cache behavior is claimed.

`linux-live.json` proves one download per concrete version, complete binary
package content, a persisted Session pin, no link retarget after updating latest
and reapplying A, new Session C selecting the newer version, and a separately
pinned Agent reusing the original cache. Claude's native discovery link reaches
`SKILL.md` inside the archive's named package directory. The scope directory
hashes deployment URL + workspace; there are no credentials in these receipts.

The pre-existing Runtime registration used for authorization is a prior lane
fixture (`819a5dc1…`, hostname metadata `botty.local`); the executing host is
explicitly recorded as Linux. The probe does **not** consume the Environment Work
queue or start an ACP/model turn. Sessions remain idle for inspection.

## Reproduce on botty when access is available

Build the CLI and probe from this branch (Node >=20):

```sh
pnpm --filter @openma/cli build
pnpm exec esbuild scripts/verify-runtime-skill-cache.ts --bundle --platform=node --format=esm --outfile=/tmp/oma-498-skill-cache-probe.mjs
```

Sync the built CLI/probe to the Mac and restart the paired PR-lane daemon using
the new CLI. Keep its existing profile and credentials. Supply a mode-0600 JSON
config to the probe with `apiUrl`, `apiKeyFile`, `runtimeTokenFile`, `runtimeId`
and `tenantId`, taken from that paired daemon. Run:

```sh
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890
# Use botty's existing Node proxy bootstrap if its fetch needs one.
OMA_PROFILE=pr498-skill-proof node /tmp/oma-498-skill-cache-probe.mjs /private/probe-config.json /tmp/botty-skill-cache.json
```

The probe reads secrets only from the supplied private files. Its output contains
no credentials. It creates its own skill/agents/environment/sessions, does no
inference and keeps all cache/link evidence. Do not present the Linux receipt as
Mac acceptance; the parent still owns the Mac/LiteBox/CI merge gates.
