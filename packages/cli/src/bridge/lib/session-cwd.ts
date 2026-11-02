/**
 * Per-session working directory management.
 *
 * The scratch dir is always `~/.oma/bridge/sessions/<session-id>/`. The
 * OMA-rendered bundle (AGENTS.md + skill files) lands there before each
 * session.start, never in the user's project root.
 *
 * The ACP process cwd is that scratch dir unless `session.start` carries
 * `cwd`. When the platform sends a project directory, the child process
 * starts there and the bundle stays in the scratch dir.
 *
 * Other reasons the scratch dir exists:
 *
 *   1. Isolation. Two parallel sessions don't see each other's transcripts
 *      or tool-call state.
 *   2. Stable transcript paths. Resume-from-disk needs a dir that does not
 *      follow whichever terminal the user ran `npx` from this morning.
 *
 * Lifecycle: dir lifetime is bound to the OMA session. Cleanup happens when
 * the platform tells the daemon `session.dispose` (which fires on
 * `DELETE /v1/sessions/:id`). The daemon does NOT auto-GC by age — leaving
 * a stale dir is preferable to deleting transcripts the user might still
 * want to resume / inspect, and only the platform knows when a session
 * is truly dead.
 *
 * The bundle (AGENTS.md + .claude/skills/...) is fetched per session.start
 * from main's `/agents/runtime/sessions/:sid/bundle?agent_id=...`, NOT
 * bundled into the daemon binary. That keeps prompts / skills owned by
 * the OMA platform per-tenant rather than baked into the npm-published CLI.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { paths } from "./platform.js";

const DIR_NAME_LEN = 12;

/**
 * Derive a short, filesystem-friendly dir name from any session id. UUIDs
 * are 36 chars and look unwieldy when listed in `~/.oma/bridge/sessions/`;
 * 12 hex chars (48 bits) are short enough to scan visually but still
 * have enough entropy to avoid practical collisions. Deterministic so
 * the same session_id always maps to the same dir (resume / cleanup work).
 */
function dirNameFor(sessionId: string): string {
  if (/^[a-f0-9]{1,12}$/i.test(sessionId)) return sessionId.toLowerCase();
  return createHash("sha256").update(sessionId).digest("hex").slice(0, DIR_NAME_LEN);
}

/**
 * Returns the cwd path for a session; creates it if it doesn't already exist.
 * Bundle materialization is the caller's job — call writeBundle() with the
 * `files: [{path, content}]` array fetched from main's
 * `/agents/runtime/sessions/:sid/bundle` before issuing session/new.
 */
export function sessionScratchDirPath(sessionId: string): string {
  return join(paths().sessionsDir, dirNameFor(sessionId));
}

export async function ensureSessionCwd(sessionId: string): Promise<string> {
  const cwd = sessionScratchDirPath(sessionId);
  await mkdir(cwd, { recursive: true });
  return cwd;
}

/**
 * Directory passed to the ACP child as its process cwd.
 *
 * Absent or blank `session.start.cwd` keeps the historical scratch dir.
 * A non-blank value is the platform's project directory and is not
 * created or written by the daemon.
 */
export function acpProcessCwd(scratchDir: string, requestedCwd?: string): string {
  const requested = requestedCwd?.trim();
  return requested ? requested : scratchDir;
}

/** Wire shape for daemon → harness session.ready after session.start. */
export function acpSessionReadyOut(params: {
  session_id: string;
  tenant_id: string;
  acp_session_id: string;
  scratchDir?: string;
  freshSpawn?: boolean;
}): {
  type: "session.ready";
  session_id: string;
  tenant_id: string;
  acp_session_id: string;
  bundle_dir?: string;
  fresh?: boolean;
} {
  const base = {
    type: "session.ready" as const,
    session_id: params.session_id,
    tenant_id: params.tenant_id,
    acp_session_id: params.acp_session_id,
  };
  if (params.freshSpawn && params.scratchDir) {
    return { ...base, bundle_dir: params.scratchDir, fresh: true };
  }
  return base;
}

/**
 * Drop bundle files from main into a session cwd. Each entry's `path` is
 * relative to cwd, can include subdirectories (mkdir -p applied). Existing
 * files at the same path are overwritten — bundle is the source of truth
 * for AGENTS.md / `.claude/skills/...` content, and we want each session
 * spawn to reflect the latest agent config.
 */
export async function writeBundle(
  cwd: string,
  files: Array<{ path: string; content: string }>,
): Promise<void> {
  for (const f of files) {
    if (f.path.startsWith("/") || f.path.includes("..")) continue; // refuse traversal
    const dst = join(cwd, f.path);
    await mkdir(dirname(dst), { recursive: true });
    await writeFile(dst, f.content);
  }
}

/**
 * Remove a session's spawn cwd. Called when the platform tells the daemon
 * `session.dispose` — i.e. the user deleted the session in OMA. Best-effort:
 * a stuck dir is preferable to a crashed daemon, so errors are swallowed.
 */
export async function removeSessionCwd(sessionId: string): Promise<void> {
  const cwd = join(paths().sessionsDir, dirNameFor(sessionId));
  try {
    await rm(cwd, { recursive: true, force: true });
  } catch {
    /* swallow — non-fatal */
  }
}
