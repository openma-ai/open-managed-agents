/**
 * `oma bridge refresh` — reconcile the daemon's authorized tenants with
 * the user's current memberships. The server always rotates every live
 * tenant's `oma_*` key on each refresh call (always-rotate strategy —
 * trades a few extra KV writes for a single response shape), so this
 * command always writes a fresh credentials file even if no tenants
 * were added or removed.
 *
 * When to run:
 *   - User joined a new workspace and wants the daemon to start serving
 *     it (the new tenant won't appear in session.start lookups until
 *     refresh).
 *   - User was removed from a workspace and the daemon should stop
 *     accepting sessions for it.
 *   - After a v1→v2 migration that fell back to the synthetic
 *     `__unknown__` tenant (offline at boot) — refresh once connectivity
 *     is back to swap in real per-tenant keys.
 *
 * Effect on a running daemon: if a `daemon.pid` exists and the process
 * is alive, we SIGHUP it so the in-memory tenant key map gets reloaded
 * without a restart. ACP child processes and WS connection are
 * undisturbed; in-flight turns keep streaming.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCreds, writeCreds, type CredentialsV2 } from "../lib/config.js";
import { paths, currentProfile } from "../lib/platform.js";
import { printBanner, log, c } from "../lib/style.js";
import { PKG_VERSION } from "../lib/version.js";

interface RefreshResponse {
  /** Live (post-reconciliation) tenants — one entry per authorized pair,
   *  each with a freshly rotated `oma_*` plaintext. */
  tenants: Array<{ id: string; name: string; role: string; agent_api_key: string }>;
}

export async function runRefresh(): Promise<void> {
  const profile = currentProfile();
  const profileTag = profile ? `  [profile=${profile}]` : "";
  printBanner(`refresh — reconcile tenants${profileTag}`, PKG_VERSION);

  const creds = await readCreds();
  if (!creds) {
    log.err("not set up — run `oma bridge setup` first");
    log.hint(`looked for ${paths().credsFile}`);
    process.exit(2);
  }

  const url = `${creds.serverUrl.replace(/\/$/, "")}/agents/runtime/${encodeURIComponent(creds.runtimeId)}/refresh`;
  let response: RefreshResponse;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    const text = await res.text();
    if (!res.ok) {
      log.err(`refresh failed: HTTP ${res.status}: ${text.slice(0, 200)}`);
      process.exit(1);
    }
    response = JSON.parse(text) as RefreshResponse;
  } catch (e) {
    log.err(`refresh request failed: ${(e as Error).message}`);
    process.exit(1);
  }

  // Diff against existing creds purely so we can print a friendly
  // "+N added, -M removed, =P existing" summary. The server's response
  // is authoritative for what we actually write — no client-side merge.
  const prevIds = new Set(creds.tenants.map((t) => t.id));
  const nextIds = new Set(response.tenants.map((t) => t.id));
  const added = response.tenants.filter((t) => !prevIds.has(t.id));
  const removed = creds.tenants.filter((t) => !nextIds.has(t.id));
  const existing = response.tenants.filter((t) => prevIds.has(t.id));

  const updated: CredentialsV2 = {
    ...creds,
    tenants: response.tenants.map((t) => ({
      id: t.id,
      name: t.name,
      agentApiKey: t.agent_api_key,
    })),
  };
  await writeCreds(updated);
  log.ok(`credentials written  ${c.dim(paths().credsFile)}`);

  const fmtList = (xs: Array<{ id: string; name: string }>) =>
    xs.length === 0 ? "—" : xs.map((t) => `${t.name} (${t.id.slice(0, 8)}…)`).join(", ");
  process.stderr.write(
    `\n  Updated: +${added.length} added, -${removed.length} removed, =${existing.length} existing\n`,
  );
  if (added.length > 0)   process.stderr.write(`  ${c.dim("added   :")} ${fmtList(added)}\n`);
  if (removed.length > 0) process.stderr.write(`  ${c.dim("removed :")} ${fmtList(removed)}\n`);
  if (existing.length > 0) process.stderr.write(`  ${c.dim("kept    :")} ${fmtList(existing)}\n`);
  process.stderr.write("\n");

  // Best-effort SIGHUP the running daemon so the new tenant set takes
  // effect immediately. The daemon's SIGHUP handler re-reads creds and
  // re-populates SessionManager's tenant key map. No-op when no daemon
  // is running (pid file missing or process gone) — the new file will
  // be picked up the next time `oma bridge daemon` starts.
  const pidFile = join(paths().configDir, "daemon.pid");
  let pid = 0;
  try {
    pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) pid = 0;
    if (pid) process.kill(pid, 0); // existence probe — throws if dead
  } catch {
    pid = 0;
  }
  if (pid === 0) {
    log.hint(`no running daemon${profileTag}; new tenants will load on next \`oma bridge daemon\` start`);
    return;
  }
  try {
    process.kill(pid, "SIGHUP");
    log.ok(`daemon${profileTag} reloading credentials (pid ${pid})`);
  } catch (e) {
    log.warn(`SIGHUP to pid ${pid} failed: ${(e as Error).message}`);
    log.hint(`creds file is still updated; restart the daemon to apply`);
    process.exit(2);
  }
}
