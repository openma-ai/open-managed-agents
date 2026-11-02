import {
  MODEL_PROVIDER_SECRET_ENV_KEYS,
  projectHostedInferenceEnv,
} from "@open-managed-agents/inference-proxy";

import {
  ACP_NATIVE_STATE_PROFILES,
  bindAcpAgentState,
  type AcpAgentStateBinding,
  type AcpNativeStateAdapterId,
  type AcpStatefulAgentSpec,
} from "./native-state.js";
import type { InferenceConfigFile } from "./inference/types.js";
import {
  ACP_PROVIDER_SECRET_ENV_KEYS,
  resolvePinnedAcpRegistryAgent,
  type PinnedAcpRegistryAgent,
} from "./acp-registry-pins.js";

/**
 * The small amount of per-agent knowledge needed before an ACP child starts.
 *
 * This is intentionally a descriptor, not a second agent protocol. It is the
 * OpenMA equivalent of Harbor's installed-agent adapter metadata: callers can
 * tell whether native files can be resumed without knowing provider paths or
 * branching on every agent id in the runtime host.
 */
export interface AcpSandboxAgentAdapterDescriptor {
  readonly id: AcpNativeStateAdapterId | "opaque";
  readonly provenance: "harbor" | "oma";
  readonly nativeResume: boolean;
}

export interface AcpSandboxAgentLifecyclePolicy {
  /** A host replacement keeps the session namespace for the next owner. */
  readonly onShutdown: "retain";
  /** A child crash keeps state so the next attempt can resume or recover. */
  readonly onCrash: "retain-and-recover";
  /** Explicit session destruction removes the isolated session namespace. */
  readonly onDestroy: "delete";
}

export interface AcpSandboxAgentLaunchSpec {
  readonly command: string;
  readonly args?: string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

/**
 * Provider-neutral preparation result for an ACP harness-in-sandbox run.
 *
 * `binding` is the persistence contract and `launch` is the process contract.
 * Keeping them together makes the Harbor-style prepare step explicit while
 * leaving ACP initialize/resume/prompt and the outer lease supervisor where
 * they already belong.
 */
export interface AcpSandboxAgentPreparation {
  readonly adapter: AcpSandboxAgentAdapterDescriptor;
  readonly binding: AcpAgentStateBinding;
  readonly launch: AcpSandboxAgentLaunchSpec;
  readonly lifecycle: AcpSandboxAgentLifecyclePolicy;
  /** Pinned registry distribution to install before spawn (absent for an explicit command). */
  readonly install?: PinnedAcpRegistryAgent;
}

/** Minimal filesystem/process surface required by the installed-agent state adapter. */
export interface AcpSandboxAgentStatePort {
  writeFile(path: string, content: string): Promise<unknown>;
  exec(command: string, timeout?: number): Promise<string>;
}

export type AcpSandboxAgentReleaseReason = "replace" | "shutdown" | "destroy";

export interface ManagedUrlMcpServerForSandbox {
  readonly name: string;
  readonly type: "url" | "sse" | "http";
  readonly url: string;
}

/** Standard MCP stdio launch declaration projected into ACP session setup. */
export interface ManagedStdioMcpServerForSandbox {
  readonly name: string;
  readonly type: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type ManagedMcpServerForSandbox =
  | ManagedUrlMcpServerForSandbox
  | ManagedStdioMcpServerForSandbox;

export interface ProjectedAcpHttpMcpServer {
  readonly type: "http";
  readonly name: string;
  readonly url: string;
  readonly headers: [{ name: "Authorization"; value: string }];
}

export interface ProjectedAcpStdioMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: string[];
  readonly env: Array<{ name: string; value: string }>;
}

export type ProjectedAcpMcpServer =
  | ProjectedAcpHttpMcpServer
  | ProjectedAcpStdioMcpServer;

const LIFECYCLE_POLICY: AcpSandboxAgentLifecyclePolicy = {
  onShutdown: "retain",
  onCrash: "retain-and-recover",
  onDestroy: "delete",
};

const OPAQUE_ADAPTER: AcpSandboxAgentAdapterDescriptor = {
  id: "opaque",
  provenance: "oma",
  nativeResume: false,
};

export interface ManagedMcpProxyCapability {
  gatewayBaseUrl: string;
  sessionsToken: string;
}

export type ManagedHostedInferenceCapability = ManagedMcpProxyCapability;

/** Decode only the official self-hosted Work secret fields needed by an ACP
 * child. Invalid or absent input is a capability miss, never a reason to fall
 * back to the original upstream MCP URL. */
export function managedHostedInferenceFromWorkEnvironment(input: {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_WORK_SECRET?: string;
}): ManagedHostedInferenceCapability | null {
  return managedMcpProxyFromWorkEnvironment(input);
}

export function managedMcpProxyFromWorkEnvironment(input: {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_WORK_SECRET?: string;
}): ManagedMcpProxyCapability | null {
  if (!input.ANTHROPIC_WORK_SECRET) return null;
  try {
    const normalized = input.ANTHROPIC_WORK_SECRET
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - normalized.length % 4) % 4),
      "=",
    );
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as {
      sessions_token?: unknown;
      api_base_url?: unknown;
    };
    const sessionsToken = decoded.sessions_token;
    const gatewayBaseUrl = typeof decoded.api_base_url === "string"
      ? decoded.api_base_url
      : input.ANTHROPIC_BASE_URL;
    if (
      typeof sessionsToken !== "string" || sessionsToken.length === 0
      || typeof gatewayBaseUrl !== "string" || gatewayBaseUrl.length === 0
    ) {
      return null;
    }
    const gateway = new URL(gatewayBaseUrl);
    if (gateway.protocol !== "http:" && gateway.protocol !== "https:") return null;
    return { gatewayBaseUrl, sessionsToken };
  } catch {
    return null;
  }
}

/**
 * Convert control-plane MCP declarations into the ACP transport handed to an
 * agent running inside a sandbox.  The upstream URL is intentionally discarded:
 * Vault resolution and OAuth refresh stay behind OpenMA's HTTP MCP gateway.
 *
 * `sessionsToken` is the already-present, short-lived Work capability — never
 * an upstream credential.  It remains in an Authorization header so it cannot
 * leak through URL logs, history, redirects, or checkpoint filenames.
 */
/** @deprecated Prefer {@link projectHostedInferenceForAcpAgent} with an injected adapter registry. */
export function projectAcpSandboxHostedInferenceEnv(input: {
  sessionId: string;
  gatewayBaseUrl?: string;
  sessionsToken?: string;
  env: Record<string, string | undefined>;
  enableProxy?: boolean;
}): Record<string, string | undefined> {
  if (
    input.enableProxy === false
    || input.sessionId.length === 0
    || !input.sessionsToken
    || !input.gatewayBaseUrl
  ) {
    return { ...input.env };
  }
  const gateway = new URL(input.gatewayBaseUrl);
  if (gateway.protocol !== "http:" && gateway.protocol !== "https:") {
    throw new Error("ACP sandbox inference proxy gateway must use HTTP or HTTPS");
  }
  const next = { ...input.env };
  for (const key of MODEL_PROVIDER_SECRET_ENV_KEYS) {
    delete next[key];
  }
  delete next.OPENAI_BASE_URL;
  return {
    ...next,
    ...projectHostedInferenceEnv(input.sessionId, {
      gatewayBaseUrl: input.gatewayBaseUrl,
      sessionsToken: input.sessionsToken,
    }),
  };
}

export async function materializeHostedInferenceConfigFiles(
  sandbox: AcpSandboxAgentStatePort,
  files: readonly InferenceConfigFile[],
): Promise<void> {
  for (const file of files) {
    await sandbox.writeFile(file.path, file.content);
  }
}

export function projectAcpSandboxMcpServers(input: {
  sessionId: string;
  gatewayBaseUrl?: string;
  sessionsToken?: string;
  servers: readonly ManagedMcpServerForSandbox[];
}): ProjectedAcpMcpServer[] {
  const urlServers = input.servers.filter((server) => server.type !== "stdio");
  if (urlServers.length > 0 && (
    input.sessionId.length === 0
    || !input.sessionsToken
    || !input.gatewayBaseUrl
  )) {
    throw new Error("ACP sandbox MCP proxy requires a Session id and Work token");
  }
  let gateway: URL | undefined;
  if (urlServers.length > 0) {
    gateway = new URL(input.gatewayBaseUrl!);
    if (gateway.protocol !== "http:" && gateway.protocol !== "https:") {
      throw new Error("ACP sandbox MCP proxy gateway must use HTTP or HTTPS");
    }
    gateway.username = "";
    gateway.password = "";
    gateway.search = "";
    gateway.hash = "";
  }
  return input.servers.flatMap<ProjectedAcpMcpServer>((server) => {
    if (server.type === "stdio") {
      return [{
        name: server.name,
        command: server.command,
        args: [...(server.args ?? [])],
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
      }];
    }
    const url = new URL(gateway!.origin);
    url.pathname = [
      "v1",
      "oma",
      "mcp-proxy",
      encodeURIComponent(input.sessionId),
      encodeURIComponent(server.name),
    ].join("/");
    return [{
      type: "http" as const,
      name: server.name,
      url: url.toString(),
      headers: [{
        name: "Authorization" as const,
        value: `Bearer ${input.sessionsToken!}`,
      }],
    }];
  });
}

/** Resolve Harbor-derived/OMA native state metadata without starting a child. */
export function resolveAcpSandboxAgentAdapter(
  agent: AcpStatefulAgentSpec,
): AcpSandboxAgentAdapterDescriptor {
  const profile = ACP_NATIVE_STATE_PROFILES.find((candidate) =>
    candidate.matches(agent)
  );
  if (!profile) return OPAQUE_ADAPTER;
  return {
    id: profile.id,
    provenance: profile.provenance,
    nativeResume: profile.resume === "native-and-acp",
  };
}

/**
 * Prepare one ACP child using the matching native-state adapter.
 *
 * The returned launch environment contains only the caller's declared
 * process environment plus the adapter's isolated state roots. Credentials
 * are intentionally not inferred from native files; the host/vault layer
 * remains responsible for model endpoint injection.
 */
export function prepareAcpSandboxAgent(input: {
  sessionId: string;
  agent: AcpSandboxAgentSpec;
}): AcpSandboxAgentPreparation {
  const { agent, install } = resolveAcpSandboxAgentSpec(input.agent);
  const binding = bindAcpAgentState({ sessionId: input.sessionId, agent });
  const adapter = resolveAcpSandboxAgentAdapter(agent);
  return {
    adapter,
    binding,
    launch: {
      command: binding.agent.command,
      args: binding.agent.args ? [...binding.agent.args] : undefined,
      cwd: binding.agent.cwd ?? "/workspace",
      env: { ...(binding.agent.env ?? {}) },
    },
    lifecycle: LIFECYCLE_POLICY,
    ...(install ? { install } : {}),
  };
}

/**
 * An ACP process declaration: either an explicit `command` (Harbor's `local`
 * distribution) or a pinned `registry` reference such as `claude-acp@0.94.0`
 * that is installed in the sandbox before the child is spawned.
 */
export type AcpSandboxAgentSpec = Omit<AcpStatefulAgentSpec, "command"> & {
  command?: string;
  registry?: string;
};

function resolveAcpSandboxAgentSpec(spec: AcpSandboxAgentSpec): {
  agent: AcpStatefulAgentSpec;
  install?: PinnedAcpRegistryAgent;
} {
  const { registry, command, ...rest } = spec;
  const hasCommand = typeof command === "string" && command.length > 0;
  const hasRegistry = typeof registry === "string" && registry.length > 0;
  if (hasCommand === hasRegistry) {
    throw new Error("ACP sandbox agent requires exactly one of command or registry");
  }
  if (hasCommand) return { agent: { ...rest, command } };
  const install = resolvePinnedAcpRegistryAgent(registry!);
  if (rest.id !== undefined && rest.id !== install.id) {
    throw new Error(
      `ACP sandbox agent id "${rest.id}" does not match registry agent "${install.id}"`,
    );
  }
  // The launcher path is only known inside the sandbox; installAcpSandboxAgent
  // fills it in. The registry id keeps native-state adapter identity.
  return { agent: { ...rest, id: install.id, command: "" }, install };
}

const INSTALL_OK_MARKER = "OMA_ACP_INSTALL_OK";
const LAUNCHER_MARKER = "OMA_ACP_LAUNCHER=";
const LAUNCHER_EOF = "OMA_ACP_LAUNCHER_EOF";
const NVM_VERSION = "v0.40.2";
// Cold path: nvm Node install (~1-2 min) plus the pinned package prefetch
// (~190 MB for claude-acp, measured ~3 min on a slow link). 20 minutes keeps
// headroom for slow mirrors while still bounding a hung install.
const INSTALL_TIMEOUT_MS = 1_200_000;

/**
 * Harbor-style install step for a pinned registry agent.
 *
 * Mirrors Harbor's AcpAgent.install() for npx distributions: ensure Node,
 * then write an `acp-launch.sh` that only `exec`s the pinned package and
 * forwards `"$@"`. Node is reused when the image already satisfies the
 * package engine; otherwise it is installed through nvm like Harbor. The
 * launcher lives under the sandbox user's HOME (no root needed) and never
 * contains launch env values: credentials stay in the spawn environment.
 *
 * Any failure rejects; there is no fallback to a bare command or to latest.
 * Re-running is idempotent (atomic rewrite of identical content, Node reuse).
 */
export async function installAcpSandboxAgent(
  sandbox: Pick<AcpSandboxAgentStatePort, "exec">,
  preparation: AcpSandboxAgentPreparation,
): Promise<AcpSandboxAgentPreparation> {
  const install = preparation.install;
  if (!install) return preparation;
  const label = `${install.id}@${install.version}`;
  let output: string;
  try {
    output = await sandbox.exec(buildAcpSandboxInstallScript(install), INSTALL_TIMEOUT_MS);
  } catch (error) {
    throw new Error(
      `ACP agent install failed for ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const launcher = parseAcpSandboxInstallOutput(output);
  if (!launcher) {
    throw new Error(`ACP agent install failed for ${label}:\n${output.trim().slice(-2_000)}`);
  }
  return {
    ...preparation,
    binding: {
      ...preparation.binding,
      agent: { ...preparation.binding.agent, command: launcher },
    },
    launch: { ...preparation.launch, command: launcher },
  };
}

/**
 * Return the launcher path only for a provably successful install.
 *
 * Exec ports report exit status in two shapes: Cloudflare prefixes
 * `exit=N\n` and appends `\nstderr: ...`; local/e2b append `\n[exit N]`
 * (or `[exit signal=...]`) only on failure. Any non-zero or signal exit
 * fails, the success marker must be the last non-empty line (so an early
 * sentinel followed by a later failure is rejected), and the last launcher
 * line wins.
 */
function parseAcpSandboxInstallOutput(raw: string): string | undefined {
  let body = raw;
  const prefixed = /^exit=(-?\d+)\n?/.exec(body);
  if (prefixed) {
    if (prefixed[1] !== "0") return undefined;
    body = body.slice(prefixed[0].length);
  }
  const lines = body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.some((line) => /^\[exit\b/.test(line))) return undefined;
  if (lines.at(-1) !== INSTALL_OK_MARKER) return undefined;
  const launcher = lines
    .filter((line) => line.startsWith(LAUNCHER_MARKER))
    .at(-1)
    ?.slice(LAUNCHER_MARKER.length)
    .trim();
  return launcher?.startsWith("/") ? launcher : undefined;
}

function buildAcpSandboxLauncherScript(install: PinnedAcpRegistryAgent): string {
  const exports = Object.entries(install.env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
    .join("");
  const exec = ["npx", "-y", shellQuote(install.package), ...install.args.map(shellQuote), '"$@"']
    .join(" ");
  return "#!/usr/bin/env sh\n"
    + "set -eu\n"
    // dash does not abort on `set -u` inside $(...); check HOME explicitly so a
    // missing HOME never silently falls through to whatever npx is on PATH.
    + 'if [ -z "${HOME:-}" ]; then echo "acp-launch.sh: HOME is not set" >&2; exit 1; fi\n'
    // Prefer an nvm-installed Node (present only when the image Node was unsuitable).
    + 'nvm_node_bin="$(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin 2>/dev/null | sort -V | tail -n 1)"\n'
    + 'if [ -n "$nvm_node_bin" ]; then PATH="$nvm_node_bin:$PATH"; export PATH; fi\n'
    + exports
    + `exec ${exec}\n`;
}

function buildAcpSandboxInstallScript(install: PinnedAcpRegistryAgent): string {
  const launcher = buildAcpSandboxLauncherScript(install);
  if (launcher.includes(LAUNCHER_EOF)) {
    throw new Error("ACP launcher content collides with the install heredoc delimiter");
  }
  const dir = `$HOME/.oma/installed-agent/${install.id}/${install.version}`;
  const major = install.nodeMajor;
  const nvm = [
    "set -eo pipefail",
    `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | env -u NODE_VERSION bash`,
    '. "$NVM_DIR/nvm.sh"',
    `nvm install ${major}`,
    `nvm alias default ${major}`,
  ].join("; ");
  const unsetSecrets = ACP_PROVIDER_SECRET_ENV_KEYS.map((key) => `-u ${key}`).join(" ");
  return [
    // One ordered stream, so the success marker is reliably the last line.
    "exec 2>&1",
    "set -eu",
    'if [ -z "${HOME:-}" ]; then echo "HOME is not set in the sandbox" >&2; exit 1; fi',
    'NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; export NVM_DIR',
    'oma_nvm_path() { nvm_bin="$(ls -d "$NVM_DIR"/versions/node/*/bin 2>/dev/null | sort -V | tail -n 1)"; if [ -n "$nvm_bin" ]; then PATH="$nvm_bin:$PATH"; export PATH; fi; }',
    "oma_node_ok() { major=\"$(node --version 2>/dev/null | sed -n 's/^v\\([0-9][0-9]*\\).*/\\1/p')\"; "
      + `[ -n "$major" ] && [ "$major" -ge ${major} ] && command -v npx >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; }`,
    "oma_nvm_path",
    "if ! oma_node_ok; then",
    `  command -v curl >/dev/null 2>&1 || { echo "Node >= ${major} with npx and npm is required and curl is unavailable to install it" >&2; exit 1; }`,
    `  bash -c ${shellQuote(nvm)} || { echo "nvm failed to install Node ${major}" >&2; exit 1; }`,
    "  oma_nvm_path",
    `  oma_node_ok || { echo "Node >= ${major} with npx and npm is unavailable after nvm install" >&2; exit 1; }`,
    "fi",
    // Prefetch the exact pinned package into the npx cache with the same
    // node/npm the launcher resolves, so the first spawn does not download it.
    // `node -e 0` exits at once; the agent binary itself would wait on stdin.
    // Provider secrets are stripped; npm config (cache, registry) is kept.
    `env ${unsetSecrets} npm exec --yes --package=${shellQuote(install.package)} -- node -e 0 </dev/null`
      + ` || { echo "npm failed to prefetch ${install.package}" >&2; exit 1; }`,
    `oma_dir="${dir}"`,
    'mkdir -p "$oma_dir"',
    'oma_tmp="$oma_dir/.acp-launch.sh.$$"',
    `cat > "$oma_tmp" <<'${LAUNCHER_EOF}'`,
    launcher.trimEnd(),
    LAUNCHER_EOF,
    'chmod 755 "$oma_tmp"',
    'mv -f "$oma_tmp" "$oma_dir/acp-launch.sh"',
    `echo "${LAUNCHER_MARKER}$oma_dir/acp-launch.sh"`,
    `echo "OMA_ACP_NODE=$(node --version)"`,
    `echo ${INSTALL_OK_MARKER}`,
  ].join("\n");
}

/** Publish the exact native-session allowlist before the child can write state. */
export async function materializeAcpSandboxAgentState(
  sandbox: AcpSandboxAgentStatePort,
  preparation: AcpSandboxAgentPreparation,
): Promise<void> {
  const binding = preparation.binding;
  await sandbox.writeFile(
    `${binding.rootPath}/session-binding.json`,
    `${JSON.stringify({
      version: 1,
      adapter_id: binding.adapterId,
      durability: binding.durability,
      resume: binding.resume,
      session_artifacts: binding.sessionArtifacts,
    })}\n`,
  );
}

/**
 * Check all artifacts that the selected adapter requires for native resume.
 * Any failed/indeterminate probe is treated as absent so callers fall back to
 * canonical-event recovery instead of sending a stale ACP session id.
 */
export async function hasRequiredAcpSandboxAgentState(
  sandbox: Pick<AcpSandboxAgentStatePort, "exec">,
  preparation: AcpSandboxAgentPreparation,
): Promise<boolean> {
  const required = preparation.binding.sessionArtifacts.filter(
    (artifact) => artifact.requiredForResume,
  );
  for (const artifact of required) {
    const predicate = artifact.kind === "directory" ? "-d" : "-f";
    try {
      const result = await sandbox.exec(
        `if [ ${predicate} ${shellQuote(sandboxShellPath(artifact.path))} ]; then printf present; else printf missing; fi`,
      );
      if (result.trim() !== "present") return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Copy only the adapter-declared native session artifacts into the durable
 * workspace checkpoint. The agent's HOME/config root remains ephemeral, so
 * credentials, provider configuration, caches and unrelated logs cannot be
 * captured accidentally.
 */
export async function captureAcpSandboxAgentState(
  sandbox: Pick<AcpSandboxAgentStatePort, "exec">,
  preparation: AcpSandboxAgentPreparation,
): Promise<void> {
  for (const artifact of preparation.binding.sessionArtifacts) {
    await sandbox.exec(copyArtifactCommand({
      source: artifact.runtimePath,
      destination: artifact.path,
      kind: artifact.kind,
    }));
  }
}

/** Restore the durable native-session allowlist into the agent's ephemeral home. */
export async function restoreAcpSandboxAgentState(
  sandbox: Pick<AcpSandboxAgentStatePort, "exec">,
  preparation: AcpSandboxAgentPreparation,
): Promise<void> {
  for (const artifact of preparation.binding.sessionArtifacts) {
    await sandbox.exec(copyArtifactCommand({
      source: artifact.path,
      destination: artifact.runtimePath,
      kind: artifact.kind,
    }));
  }
}

/** Apply the adapter lifecycle policy after the ACP child is stopped. */
export async function releaseAcpSandboxAgentState(
  sandbox: Pick<AcpSandboxAgentStatePort, "exec">,
  preparation: AcpSandboxAgentPreparation,
  reason: AcpSandboxAgentReleaseReason,
): Promise<void> {
  // Remove the complete per-session runtime namespace, not only its native/
  // child. Real sandboxes discard /tmp with the runtime; host-backed local
  // adapters share the OS temp directory and would otherwise accumulate an
  // empty openma-harness-state tree across every session.
  const runtimeRoot = posixDirname(preparation.binding.nativePath);
  const adapterRoot = posixDirname(runtimeRoot);
  const sessionRoot = posixDirname(adapterRoot);
  const acpRoot = posixDirname(sessionRoot);
  const scratchRoot = posixDirname(acpRoot);
  await sandbox.exec(
    `rm -rf -- ${shellQuote(sandboxShellPath(runtimeRoot))}; `
      + `rmdir -- ${[
        adapterRoot,
        sessionRoot,
        acpRoot,
        scratchRoot,
      ].map((path) => shellQuote(sandboxShellPath(path))).join(" ")} `
      + "2>/dev/null || true",
  );
  if (reason !== "destroy") return;
  await sandbox.exec(
    `rm -rf -- ${shellQuote(sandboxShellPath(preparation.binding.rootPath))}`,
  );
}

function copyArtifactCommand(input: {
  source: string;
  destination: string;
  kind: "directory" | "file" | "sqlite";
}): string {
  const source = shellQuote(sandboxShellPath(input.source));
  const destinationPath = sandboxShellPath(input.destination);
  const destination = shellQuote(destinationPath);
  const destinationParent = shellQuote(posixDirname(destinationPath));
  const predicate = input.kind === "directory" ? "-d" : "-f";
  const copyFlag = input.kind === "directory" ? "-R" : "-f";
  const sidecars = input.kind === "sqlite"
    ? ["-wal", "-shm"].map((suffix) => {
      const sourceSidecar = `${sandboxShellPath(input.source)}${suffix}`;
      const destinationSidecar = `${destinationPath}${suffix}`;
      return `if [ -f ${shellQuote(sourceSidecar)} ]; then cp -f -- ${shellQuote(sourceSidecar)} ${shellQuote(destinationSidecar)}; else rm -f -- ${shellQuote(destinationSidecar)}; fi`;
    }).join("; ")
    : "";
  const cleanup = input.kind === "sqlite"
    ? `rm -f -- ${destination} ${shellQuote(`${destinationPath}-wal`)} ${shellQuote(`${destinationPath}-shm`)}`
    : `rm -rf -- ${destination}`;
  return [
    `mkdir -p -- ${destinationParent}`,
    `if [ ${predicate} ${source} ]; then ${cleanup}; cp ${copyFlag} -- ${source} ${destination}${sidecars ? `; ${sidecars}` : ""}; else ${cleanup}; fi`,
  ].join("; ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sandboxShellPath(path: string): string {
  return path.startsWith("/workspace/")
    ? path.slice("/workspace/".length)
    : path;
}

function posixDirname(path: string): string {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}
