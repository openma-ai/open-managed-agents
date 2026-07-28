/**
 * `oma bridge profiles list` — enumerate every daemon profile installed
 * on this machine, regardless of whether OMA_PROFILE is currently set.
 *
 * The implicit data model from platform.ts: each profile lives at
 * `~/.oma/bridge[-<profile>]/`, with a `credentials.json` (v2 multi-
 * tenant or legacy v1) and an optional `daemon.pid`. There's no
 * registry — the existence of a per-profile config dir IS the
 * registry. We just walk `~/.oma/` and pick out anything matching
 * `bridge` or `bridge-<slug>`.
 *
 * Per profile we report: serverUrl, runtimeId (short), authorized
 * tenant count, and whether the daemon is alive (pid file exists +
 * process responds to signal 0). Output is plain text — pipe through
 * `column -t` if you want neat columns.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { c, printBanner } from "../lib/style.js";
import { PKG_VERSION } from "../lib/version.js";

interface ProfileInfo {
  /** Empty string for the default profile (no suffix). */
  profile: string;
  configDir: string;
  /** Null when credentials.json is missing or unreadable. */
  serverUrl: string | null;
  runtimeId: string | null;
  tenantCount: number | null;
  /** Inferred from format of credentials.json — useful for spotting
   *  profiles that haven't yet been touched by a v2-aware daemon. */
  credsVersion: 1 | 2 | "unknown";
  daemonPid: number | null;
  daemonAlive: boolean;
}

export async function runProfilesList(): Promise<void> {
  printBanner("bridge profiles — installed daemon profiles", PKG_VERSION);

  const omaRoot = join(homedir(), ".oma");
  let entries: string[];
  try {
    entries = await readdir(omaRoot);
  } catch {
    process.stderr.write(c.dim(`  (no profiles installed — ${omaRoot} doesn't exist)\n`));
    return;
  }

  // Each profile dir is `bridge` (default) or `bridge-<slug>` (named).
  // Filter both forms; ignore anything else under ~/.oma/.
  const profiles: ProfileInfo[] = [];
  for (const name of entries.sort()) {
    if (name !== "bridge" && !name.startsWith("bridge-")) continue;
    const profile = name === "bridge" ? "" : name.slice("bridge-".length);
    profiles.push(await readProfile(profile, join(omaRoot, name)));
  }

  if (profiles.length === 0) {
    process.stderr.write(c.dim("  (no profiles installed)\n"));
    process.stderr.write(`  Run ${c.cyan("oma bridge setup")} to create one.\n`);
    return;
  }

  // Plain-text table. Caller can `column -t` for alignment if they
  // care; we don't enforce a specific column scheme.
  process.stderr.write(
    `  ${c.dim("PROFILE")}\t${c.dim("SERVER")}\t${c.dim("RUNTIME")}\t${c.dim("TENANTS")}\t${c.dim("DAEMON")}\n`,
  );
  for (const p of profiles) {
    const profileLabel = p.profile === "" ? c.bold("(default)") : c.bold(p.profile);
    const server = p.serverUrl ?? c.dim("—");
    const runtime = p.runtimeId ? p.runtimeId.slice(0, 8) + "…" : c.dim("—");
    const tenants =
      p.tenantCount === null
        ? c.dim("—")
        : p.credsVersion === 1
          ? `1 ${c.dim("(v1 creds — pre-multi-tenant)")}`
          : String(p.tenantCount);
    const daemon = p.daemonPid
      ? p.daemonAlive
        ? `${c.green("●")} pid ${p.daemonPid}`
        : `${c.yellow("○")} pid ${p.daemonPid} ${c.dim("(stale)")}`
      : c.dim("—");
    process.stderr.write(`  ${profileLabel}\t${server}\t${runtime}\t${tenants}\t${daemon}\n`);
  }

  process.stderr.write(
    `\n  ${c.dim(
      "Switch active profile with `OMA_PROFILE=<name> oma bridge <cmd>` (or --profile=<name>).",
    )}\n`,
  );
}

async function readProfile(profile: string, configDir: string): Promise<ProfileInfo> {
  const info: ProfileInfo = {
    profile,
    configDir,
    serverUrl: null,
    runtimeId: null,
    tenantCount: null,
    credsVersion: "unknown",
    daemonPid: null,
    daemonAlive: false,
  };

  try {
    const raw = await readFile(join(configDir, "credentials.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      v?: number;
      serverUrl?: string;
      runtimeId?: string;
      agentApiKey?: string;
      tenants?: Array<unknown>;
    };
    info.serverUrl = parsed.serverUrl ?? null;
    info.runtimeId = parsed.runtimeId ?? null;
    if (parsed.v === 2 && Array.isArray(parsed.tenants)) {
      info.credsVersion = 2;
      info.tenantCount = parsed.tenants.length;
    } else if (parsed.agentApiKey) {
      info.credsVersion = 1;
      info.tenantCount = 1;
    }
  } catch {
    // creds missing/corrupt — leave server/runtime/tenants as null
  }

  try {
    const pidStr = (await readFile(join(configDir, "daemon.pid"), "utf-8")).trim();
    const pid = parseInt(pidStr, 10);
    if (Number.isFinite(pid) && pid > 0) {
      info.daemonPid = pid;
      try {
        // signal 0 = "are you there?" — throws on missing/dead pid.
        process.kill(pid, 0);
        info.daemonAlive = true;
      } catch {
        info.daemonAlive = false;
      }
    }
  } catch {
    // no pid file — daemon never wrote one, or was uninstalled
  }

  return info;
}
