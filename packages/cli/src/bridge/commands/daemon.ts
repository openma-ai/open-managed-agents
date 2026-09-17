import { startKeepAwake } from "../lib/keep-awake.js";
/**
 * `oma bridge daemon` — long-running reverse-WS to the control plane.
 *
 * CLI composition: credentials, registry, signals and graceful process exit.
 * The shared daemon connection owns attachment, heartbeat and reconnect;
 * SessionManager retains native sessions across transport interruptions.
 */

import { hostname } from "node:os";
import { DaemonHost } from "@openma/common/local-runtime";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { readCreds } from "../lib/config.js";
import { osTag, currentProfile, paths } from "../lib/platform.js";
import { detectAll, loadRegistry } from "@open-managed-agents/acp-runtime/registry";
import { SessionManager } from "../lib/session-manager.js";
import { createNodeSessionManagerRuntimeDependencies } from "../lib/node-session-runtime.js";
import { createCliDaemonConnection } from "../lib/daemon-client.js";
import { detectLocalSkills } from "../lib/local-skills.js";
import { printBanner, log } from "../lib/style.js";
import { PKG_VERSION } from "../lib/version.js";
export async function runDaemon(): Promise<void> {
  const creds = await readCreds();
  if (!creds) {
    process.stderr.write(
      "✗ no credentials. Run `oma bridge setup` first.\n",
    );
    process.exit(2);
  }

  const profile = currentProfile();
  const profileTag = profile ? `  [profile=${profile}]` : "";
  printBanner(`daemon — runtime ${creds.runtimeId.slice(0, 8)}… → ${creds.serverUrl}${profileTag}`, PKG_VERSION);

  // Warm the merged ACP registry cache (official @cdn.agentclientprotocol.com
  // + OMA overlay) once at startup. All downstream sync resolveKnownAgent /
  // detect / detectAll calls in this process then read from the cached
  // merged list. Network failure here is non-fatal — registry-fetch falls
  // back to disk cache, then to overlay-only; the daemon must keep working
  // for users on planes / dev networks.
  const cachePath = join(paths().configDir, "registry-cache.json");
  await loadRegistry({ cachePath });

  // The reusable host owns drain/disposal ordering. This CLI adapter alone
  // owns OS signals, discovery files, logging and process exit.
  const DRAIN_DEADLINE_MS = 10_000;
  let draining = false;
  let host!: DaemonHost;
  let connection: ReturnType<typeof createCliDaemonConnection> | undefined;
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => { finish = resolve; });
  const stop = (reason: string) => {
    if (draining) {
      log.warn(`${reason} again — forcing owned session cleanup`);
      // Same promise as the first stop; its rejection is already observed.
      void host.stop({ force: true });
      return;
    }
    draining = true;
    log.step(`${reason} received, draining (${DRAIN_DEADLINE_MS / 1000}s deadline)`);
    void host.stop().then((result) => {
      if (result.kind === "forced") { log.warn("daemon shutdown forced"); return; }
      const r = result.summary;
      if (r.abortedTurns > 0) log.warn(`deadline reached — aborted ${r.abortedTurns} in-flight turn(s)`);
      log.ok(`drained ${r.sessions} session(s) (${r.initialTurns - r.abortedTurns}/${r.initialTurns} turns completed cleanly)`);
    }).catch((error) => {
      log.err(`daemon shutdown failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }).finally(finish);
  };
  const onTerminate = () => stop("SIGTERM");
  const onInterrupt = () => stop("SIGINT");

  // SIGHUP — `oma bridge agents refresh` AND `oma bridge refresh`. Both
  // are side-channel reloads: do NOT touch the WS, do NOT restart
  // sessions, do NOT kill ACP children. Two things to refresh:
  //   1. Agent detection — re-fetch official ACP registry, re-snapshot
  //      npm/uv installs, re-scan local skills, re-send the hello
  //      manifest so the relay reflects new wrappers the user installed.
  //   2. Per-tenant credentials — re-read the creds file and push the
  //      updated tenant key map into SessionManager so newly-authorized
  //      tenants become sessionable without a daemon restart. The creds
  //      file may also have been replaced with a new token via setup
  //      --force, but we deliberately DON'T reattach the WS here — the
  //      next reconnect cycle picks the new token up. (Tenant key
  //      changes happen far more often than token rotation, and reloading
  //      keys with stale `creds` in scope is harmless because the WS
  //      uses the original auth bearer only.)
  const onRefresh = () => {
    if (draining) return;
    void (async () => {
      log.step("SIGHUP — refreshing agent detection + credentials");
      try {
        const freshCreds = await readCreds();
        if (draining) return;
        if (freshCreds) {
          sessions.setTenantKeys(freshCreds.tenants);
          log.ok(`re-loaded credentials  (${freshCreds.tenants.length} tenants)`);
        } else {
          log.warn("credentials file disappeared mid-SIGHUP; tenant keys unchanged");
        }
        await loadRegistry({ cachePath, forceRefresh: true });
        const refreshedManifest = await manifest();
        if (draining) return;
        if (connection?.send(refreshedManifest)) {
          log.ok("re-published agent and skill manifest");
        } else {
          log.warn("WS not attached — manifest will be re-sent on next connect");
        }
      } catch (e) {
        log.warn(`refresh failed: ${(e as Error).message}`);
      }
    })();
  };

  // SessionManager survives WS drops — keeps the ACP child processes alive
  // so a brief network blip doesn't kill in-progress conversations. Each
  // WS attach calls setSender() to point at the new socket.
  const sessions = new SessionManager(
    () => {
      /* placeholder — replaced on first attach via setSender */
    },
    createNodeSessionManagerRuntimeDependencies(),
  );
  // Wire daemon's identity into SessionManager so it can fetch session
  // bundles from main and stamp the right per-tenant API key onto ACP
  // children's MCP proxy auth (no spawn-env LLM key — user manages that
  // themselves). The per-tenant `oma_*` keys come from setTenantKeys
  // below, NOT from setSpawnEnv — keys live in a tenant-keyed map so a
  // multi-tenant daemon can hand the right one to each spawned ACP
  // child based on the session's tenant_id pin.
  sessions.setSpawnEnv({
    apiUrl: creds.serverUrl,
    runtimeToken: creds.token,
  });
  sessions.setTenantKeys(creds.tenants);

  async function manifest(): Promise<Record<string, unknown>> {
    const agents = (await detectAll()).map((a) => ({ id: a.id, binary: a.spec.command }));
    const localSkillsDetailed = await detectLocalSkills();
    const localSkills: Record<string, unknown> = {};
    for (const [agentId, skills] of Object.entries(localSkillsDetailed)) {
      if (skills) localSkills[agentId] = skills.map(({ path: _path, ...rest }) => rest);
    }
    return { type: "hello", machine_id: creds!.machineId, hostname: hostname(),
      os: osTag(), version: PKG_VERSION, agents, local_skills: localSkills };
  }

  connection = createCliDaemonConnection({
    serverUrl: creds.serverUrl, token: creds.token, sessions, manifest,
    onState(state) {
      if (state === "online") log.ok("runtime attached");
      if (state === "offline") log.warn("runtime connection interrupted; reconnecting");
      if (state === "occupied" || state === "expired") {
        log.warn(state === "occupied" ? "runtime already has an execution host" : "runtime authorization expired");
        stop(state);
      }
    },
  });
  host = new DaemonHost({
    connection, sessions, drainDeadlineMs: DRAIN_DEADLINE_MS,
    onProgress: (active, msLeft) => log.hint(`${active} turns active, ${Math.ceil(msLeft / 1000)}s left`),
  });
  process.on("SIGTERM", onTerminate);
  process.on("SIGINT", onInterrupt);
  process.on("SIGHUP", onRefresh);
  const stopKeepAwake = startKeepAwake({ warn: (message) => log.warn(message) });
  const pidPath = join(paths().configDir, "daemon.pid");
  try {
    try {
      mkdirSync(paths().configDir, { recursive: true });
      writeFileSync(pidPath, String(process.pid), "utf-8");
    } catch (error) {
      log.warn(`pid file write failed (non-fatal): ${(error as Error).message}`);
    }
    host.start();
    await stopped;
  } finally {
    stopKeepAwake();
    process.off("SIGTERM", onTerminate);
    process.off("SIGINT", onInterrupt);
    process.off("SIGHUP", onRefresh);
    // Keep discovery present during drain; never remove a successor's record.
    try { if (readFileSync(pidPath, "utf8").trim() === String(process.pid)) unlinkSync(pidPath); } catch { /* missing */ }
  }
  log.step("daemon exited");
  process.exit(process.exitCode ?? 0);
}
