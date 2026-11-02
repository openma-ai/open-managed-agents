// Install an Environment's `packages` into a sandbox, once per container.
//
// Shared by the Cloudflare SessionDO warmup and the Node managed runtime.
// Three paths, decided by two markers:
//
//   warm     → markers in /tmp + /workspace both match → no-op
//   restored → /tmp marker gone but /workspace marker survived backup
//              → only re-install apt (lang packages already in /workspace
//              came back with the workspace)
//   fresh    → both markers gone → full setup
//
// Lang packages (pip/npm/cargo/go) go under /workspace/.<lang>/ so a
// workspace backup carries them. Apt installs to /usr, which a backup
// cannot carry, so a cold restart re-runs it.

/** The `packages` of a cloud Environment. */
export interface EnvironmentPackages {
  pip?: readonly string[];
  npm?: readonly string[];
  apt?: readonly string[];
  cargo?: readonly string[];
  /** Accepted but skipped: the sandbox images ship no Ruby. */
  gem?: readonly string[];
  go?: readonly string[];
}

export interface EnvironmentPackagesOptions {
  /**
   * A Python package index to install pip packages from, for sandboxes
   * whose network reaches a mirror faster than pypi.org.
   */
  pipIndexUrl?: string;
  /**
   * Alias of the operator catalog image the sandbox runs (`SANDBOX_IMAGES`).
   * Unset means the deployment default image, and the setup markers are
   * exactly as before. When set, the alias is part of both markers, so a
   * workspace restored onto a different image is not trusted: the fresh path
   * removes its `/workspace/.venv` (bound to the old image's Python) and
   * reinstalls.
   */
  sandboxImage?: string;
}

const SANDBOX_IMAGE_ALIAS = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** The markers for a package list on a given image. */
function setupMarkers(
  packages: EnvironmentPackages | undefined,
  sandboxImage: string | undefined,
): { full: string; lang: string } {
  const full = fullHash(packages);
  const lang = langHash(packages);
  if (sandboxImage === undefined) return { full, lang };
  if (!SANDBOX_IMAGE_ALIAS.test(sandboxImage)) {
    throw new TypeError(`Invalid sandbox image alias for environment packages: ${JSON.stringify(sandboxImage)}`);
  }
  return { full: `${full}:${sandboxImage}`, lang: `${lang}:${sandboxImage}` };
}

/** Directories the installed tools live in, in PATH order. */
export const ENVIRONMENT_PACKAGE_PATHS = [
  "/workspace/.venv/bin",
  "/workspace/.npm-global/bin",
  "/workspace/.cargo/bin",
  "/workspace/.go/bin",
] as const;

const WARM_MARKER = "/tmp/.oma-setup-warm";
const RESTORED_MARKER = "/workspace/.oma-setup-restored";

/** A sandbox that runs shell commands. */
export interface PackageSandbox {
  exec(command: string, timeout?: number): Promise<string>;
}

export type EnvironmentPackagesPath = "warm" | "restored" | "fresh";

export type EnvironmentPackagesProgress =
  | { kind: "step"; step: "running_setup" | "reinstalling_apt"; reason?: string }
  | { kind: "done"; path: EnvironmentPackagesPath; durationMs: number };

/** Exit code reported by {@link parseExecResult} when a command did not
 * report a numeric exit status (killed by a signal, unknown exit, or the
 * adapter could not run it at all). Always a failure. */
export const UNKNOWN_EXIT_CODE = -1;

/**
 * Read an exec result. Adapters report the status in one of these shapes,
 * always at the start or the end of the output, never in the middle (text in
 * the middle is command output, even when it looks like a status):
 *
 * - "exit=N\n<stdout>\nstderr: <stderr>" (Cloudflare sandbox);
 *   "exit=N\n<stdout>[stderr:<stderr>]" (BoxRun, `exit=?` when unknown);
 * - "<output>\n[exit N]" on failure (most adapters), where LocalSubprocess
 *   writes "[exit exit=N]" or "[exit signal=SIGTERM]";
 * - "[error: <message>]" as the whole output when the adapter could not run
 *   the command.
 *
 * Statuses without a numeric exit code map to {@link UNKNOWN_EXIT_CODE}.
 */
export function parseExecResult(raw: string): { exitCode: number; stdout: string; stderr: string } {
  const prefixed = raw.match(/^exit=(-?\d+|\?)\n?/);
  if (prefixed) {
    const exitCode = prefixed[1] === "?" ? UNKNOWN_EXIT_CODE : parseInt(prefixed[1]!, 10);
    const rest = raw.slice(prefixed[0].length);
    const marker = "\nstderr: ";
    const idx = rest.indexOf(marker);
    if (idx >= 0) {
      return { exitCode, stdout: rest.slice(0, idx), stderr: rest.slice(idx + marker.length) };
    }
    const boxrunStderr = rest.match(/\[stderr:([\s\S]*)\]$/);
    if (boxrunStderr) {
      return { exitCode, stdout: rest.slice(0, boxrunStderr.index), stderr: boxrunStderr[1]! };
    }
    return { exitCode, stdout: rest, stderr: "" };
  }
  const suffixed = raw.match(/(?:^|\n)\[exit (?:exit=)?([^\]\n]*)\]\s*$/);
  if (suffixed) {
    const status = suffixed[1]!;
    return {
      exitCode: /^-?\d+$/.test(status) ? parseInt(status, 10) : UNKNOWN_EXIT_CODE,
      stdout: raw.slice(0, suffixed.index),
      stderr: status.startsWith("signal=") ? status : "",
    };
  }
  const failed = raw.match(/^\[error: ([\s\S]*)\]\s*$/);
  if (failed) {
    return { exitCode: UNKNOWN_EXIT_CODE, stdout: "", stderr: failed[1]! };
  }
  return { exitCode: 0, stdout: raw, stderr: "" };
}

/** Whether the packages ask for anything to be installed. */
export function hasEnvironmentPackages(packages: EnvironmentPackages | undefined): boolean {
  if (!packages) return false;
  return [packages.pip, packages.npm, packages.apt, packages.cargo, packages.go].some(
    (list) => (list?.length ?? 0) > 0,
  );
}

/** The apt-only install script; empty when there are no apt packages. */
export function buildAptScript(apt: readonly string[] | undefined): string {
  if (!apt || apt.length === 0) return "";
  return `apt-get update -qq && apt-get install -y -qq --no-install-recommends ${apt.map(shellQuote).join(" ")}`;
}

/**
 * The full setup script (apt + langs into /workspace), run in a subshell.
 * It stops at the first failing step, so a failed install is reported
 * rather than masked by the steps after it.
 *
 *   pip   → /workspace/.venv (uv; installed with pip when the image lacks it;
 *           created with --system-site-packages so image-baked packages resolve)
 *   npm   → /workspace/.npm-global
 *   cargo → /workspace/.cargo
 *   go    → /workspace/.go
 *
 * Also writes /workspace/.oma-env, which a shell can `source` for PATH.
 */
export function buildFullSetupScript(
  packages: EnvironmentPackages | undefined,
  options: EnvironmentPackagesOptions = {},
): string {
  return buildSetupScript(packages, options, options.sandboxImage !== undefined);
}

/** `dropVenv`: the workspace venv may belong to another image's Python, so
 * the fresh path must recreate it instead of reusing it. */
function buildSetupScript(
  packages: EnvironmentPackages | undefined,
  options: EnvironmentPackagesOptions,
  dropVenv: boolean,
): string {
  // On a catalog image, or when the workspace was last set up on one, the
  // fresh path never trusts a restored venv: it may target the Python of
  // another image. It is dropped even when no pip packages are listed now,
  // so a stale interpreter is not left first on PATH or reused later.
  const dropStaleVenv = dropVenv ? [`rm -rf /workspace/.venv`] : [];
  if (!hasEnvironmentPackages(packages)) {
    return dropStaleVenv.length > 0 ? `(\nset -e\n${dropStaleVenv.join("\n")}\n)` : "";
  }
  const sections: string[] = ["set -e"];

  const apt = buildAptScript(packages!.apt);
  if (apt) sections.push(apt);

  const pip = packages!.pip ?? [];
  if (pip.length === 0) sections.push(...dropStaleVenv);
  if (pip.length > 0) {
    const index = options.pipIndexUrl?.trim();
    if (index) {
      sections.push(`export UV_INDEX_URL=${shellQuote(index)} PIP_INDEX_URL=${shellQuote(index)}`);
    }
    sections.push(
      `mkdir -p /workspace`,
      ...dropStaleVenv,
      // Images without uv get it from pip; PEP 668 images need the override.
      `if command -v uv >/dev/null 2>&1; then UV=uv; else python3 -m pip install -q --user --break-system-packages uv 2>/dev/null || python3 -m pip install -q --user uv; UV="python3 -m uv"; fi`,
      // --system-site-packages: packages baked into the image's system Python
      // (e.g. an operator SANDBOX_IMAGES entry) stay importable from the venv,
      // so an Environment only lists what the image lacks.
      `[ -d /workspace/.venv ] || $UV venv -q --system-site-packages /workspace/.venv`,
      `$UV pip install --python /workspace/.venv/bin/python -q ${pip.map(shellQuote).join(" ")}`,
    );
  }

  const npm = packages!.npm ?? [];
  if (npm.length > 0) {
    sections.push(
      `mkdir -p /workspace/.npm-global`,
      `npm config set prefix /workspace/.npm-global`,
      `npm install -g --silent ${npm.map(shellQuote).join(" ")}`,
    );
  }

  const cargo = packages!.cargo ?? [];
  if (cargo.length > 0) {
    sections.push(
      `export CARGO_HOME=/workspace/.cargo`,
      `mkdir -p $CARGO_HOME`,
      `cargo install --quiet ${cargo.map(shellQuote).join(" ")}`,
    );
  }

  const go = packages!.go ?? [];
  if (go.length > 0) {
    sections.push(
      `export GOPATH=/workspace/.go GOMODCACHE=/workspace/.go/pkg/mod GOBIN=/workspace/.go/bin`,
      `mkdir -p $GOBIN`,
      ...go.map((pkg) => `go install ${shellQuote(pkg)}`),
    );
  }

  sections.push(
    `cat > /workspace/.oma-env <<'EOF'`,
    `export PATH=${ENVIRONMENT_PACKAGE_PATHS.join(":")}:$PATH`,
    `export CARGO_HOME=/workspace/.cargo`,
    `export GOPATH=/workspace/.go`,
    `export GOMODCACHE=/workspace/.go/pkg/mod`,
    `EOF`,
  );
  // A subshell keeps `set -e` and the exports out of a shared shell session.
  return `(\n${sections.join("\n")}\n)`;
}

const langHash = (packages: EnvironmentPackages | undefined): string =>
  fnv1a(JSON.stringify({
    pip: packages?.pip ?? [],
    npm: packages?.npm ?? [],
    cargo: packages?.cargo ?? [],
    go: packages?.go ?? [],
  }));

const fullHash = (packages: EnvironmentPackages | undefined): string =>
  fnv1a(JSON.stringify({
    apt: packages?.apt ?? [],
    pip: packages?.pip ?? [],
    npm: packages?.npm ?? [],
    cargo: packages?.cargo ?? [],
    go: packages?.go ?? [],
  }));

async function probeSetupState(
  sandbox: PackageSandbox,
  full: string,
  lang: string,
): Promise<{ path: EnvironmentPackagesPath; restoredMarker: string }> {
  try {
    const raw = await sandbox.exec(
      `WARM=$(cat ${WARM_MARKER} 2>/dev/null || echo MISSING); ` +
      `REST=$(cat ${RESTORED_MARKER} 2>/dev/null || echo MISSING); ` +
      `echo "WARM=$WARM"; echo "REST=$REST"`,
      15_000,
    );
    const { stdout } = parseExecResult(raw);
    const warm = (stdout.match(/WARM=(\S+)/)?.[1] ?? "MISSING").trim();
    const rest = (stdout.match(/REST=(\S+)/)?.[1] ?? "MISSING").trim();
    // Warm needs both markers: a sandbox created from a prepared-base snapshot
    // carries the builder's /tmp marker even after a workspace checkpoint
    // replaced /workspace underneath it.
    if (warm === full && rest === lang) return { path: "warm", restoredMarker: rest };
    if (rest === lang) return { path: "restored", restoredMarker: rest };
    return { path: "fresh", restoredMarker: rest };
  } catch {
    return { path: "fresh", restoredMarker: "MISSING" };
  }
}

/**
 * Install the packages unless this container (or its restored workspace)
 * already has them. Call after the sandbox is ready and its workspace has
 * been restored. Never throws for a failed install: the result carries
 * `error` so the caller can report it and carry on.
 */
export async function ensureEnvironmentPackages(
  sandbox: PackageSandbox,
  packages: EnvironmentPackages | undefined,
  onProgress?: (event: EnvironmentPackagesProgress) => void,
  options: EnvironmentPackagesOptions = {},
): Promise<{ path: EnvironmentPackagesPath; durationMs: number; error?: string }> {
  const startMs = Date.now();
  const { full, lang } = setupMarkers(packages, options.sandboxImage);
  const markers = `echo "${full}" > ${WARM_MARKER}; mkdir -p /workspace; echo "${lang}" > ${RESTORED_MARKER}`;

  const probe = await probeSetupState(sandbox, full, lang);
  const state = probe.path;
  if (state === "warm") {
    onProgress?.({ kind: "done", path: "warm", durationMs: Date.now() - startMs });
    return { path: "warm", durationMs: Date.now() - startMs };
  }

  if (state === "restored") {
    onProgress?.({ kind: "step", step: "reinstalling_apt" });
    const aptScript = buildAptScript(packages?.apt);
    if (aptScript) {
      const r = parseExecResult(await sandbox.exec(aptScript, 180_000));
      if (r.exitCode !== 0) {
        return {
          path: "restored",
          durationMs: Date.now() - startMs,
          error: `apt_install_failed exit=${r.exitCode}: ${(r.stderr || r.stdout || "").slice(-300)}`,
        };
      }
    }
    await sandbox.exec(markers);
    onProgress?.({ kind: "done", path: "restored", durationMs: Date.now() - startMs });
    return { path: "restored", durationMs: Date.now() - startMs };
  }

  onProgress?.({ kind: "step", step: "running_setup" });
  // Catalog-image markers are `<hash>:<alias>`. A workspace last set up on a
  // catalog image keeps that image's venv even when switching back to the
  // default image, so it is dropped too. Default-only workspaces never carry
  // the suffix and get exactly the script they always did.
  const fullScript = buildSetupScript(
    packages,
    options,
    options.sandboxImage !== undefined || probe.restoredMarker.includes(":"),
  );
  if (fullScript) {
    const r = parseExecResult(await sandbox.exec(fullScript, 600_000));
    if (r.exitCode !== 0) {
      return {
        path: "fresh",
        durationMs: Date.now() - startMs,
        error: `full_setup_failed exit=${r.exitCode}: ${(r.stderr || r.stdout || "").slice(-300)}`,
      };
    }
  }
  await sandbox.exec(markers);
  onProgress?.({ kind: "done", path: "fresh", durationMs: Date.now() - startMs });
  return { path: "fresh", durationMs: Date.now() - startMs };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
