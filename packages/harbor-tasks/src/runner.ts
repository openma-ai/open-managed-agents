import type { HarborTaskFile } from "./bundle";
import { UnsupportedHarborTaskError, type HarborTask } from "./task";

/**
 * The part of the OMA SandboxPort a Harbor trial needs. Kept narrow so any
 * provider adapter (or a managed Session sandbox later) can host a trial.
 */
export interface HarborTrialSandbox {
  exec(command: string, timeout?: number): Promise<string>;
  writeFileBytes?(path: string, bytes: Uint8Array): Promise<unknown>;
  writeFile(path: string, content: string): Promise<unknown>;
}

/** Harbor's EnvironmentPaths for Linux containers. */
export const HARBOR_PATHS = {
  agentDir: "/logs/agent",
  verifierDir: "/logs/verifier",
  artifactsDir: "/logs/artifacts",
  testsDir: "/tests",
  solutionDir: "/solution",
  rewardText: "/logs/verifier/reward.txt",
  rewardJson: "/logs/verifier/reward.json",
  testStdout: "/logs/verifier/test-stdout.txt",
  oracleLog: "/logs/agent/oracle.txt",
} as const;

const EXIT_MARKER = "__OMA_HARBOR_EXIT__=";
const REWARD_MARKER = "__OMA_HARBOR_REWARD__";
const REWARD_END = "__OMA_HARBOR_REWARD_END__";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ShellResult { exitCode: number; output: string }

/**
 * Run a command the way Harbor's environment.exec does: in the container's
 * working directory with the given environment. The exit code is captured
 * with a marker because provider adapters report it in different formats.
 */
export async function runInTask(
  sandbox: HarborTrialSandbox,
  command: string,
  options: { workdir: string | null; env?: Record<string, string>; timeoutMs?: number },
): Promise<ShellResult> {
  const exports = Object.entries(options.env ?? {})
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
      return `export ${key}=${shellQuote(value)}; `;
    })
    .join("");
  const cd = options.workdir ? `cd ${shellQuote(options.workdir)} && ` : "";
  const script = `${exports}${cd}( ${command} ); echo; echo ${EXIT_MARKER}$?`;
  const raw = await sandbox.exec(`bash -c ${shellQuote(script)}`, options.timeoutMs);
  const at = raw.lastIndexOf(EXIT_MARKER);
  if (at < 0) throw new Error(`Command did not report an exit status: ${raw.slice(-500)}`);
  const exitCode = Number.parseInt(raw.slice(at + EXIT_MARKER.length), 10);
  return { exitCode, output: raw.slice(0, at).replace(/\n$/, "") };
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const UPLOAD_CHUNK = 48_000;

/** Write one file through exec when the sandbox has no binary write (managed Session exec). */
async function writeViaExec(sandbox: HarborTrialSandbox, path: string, bytes: Uint8Array): Promise<void> {
  const encoded = toBase64(bytes);
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  for (let offset = 0; offset === 0 || offset < encoded.length; offset += UPLOAD_CHUNK) {
    const redirect = offset === 0 ? ">" : ">>";
    const part = encoded.slice(offset, offset + UPLOAD_CHUNK);
    const result = await runInTask(sandbox, `mkdir -p ${shellQuote(dir)} && printf '%s' ${shellQuote(part)} | base64 -d ${redirect} ${shellQuote(path)}`, { workdir: null });
    if (result.exitCode !== 0) throw new Error(`Upload of ${path} failed: ${result.output.slice(0, 300)}`);
  }
}

/** Copy task files into the sandbox under `target`, preserving executable bits. */
export async function uploadFiles(sandbox: HarborTrialSandbox, files: readonly HarborTaskFile[], target: string): Promise<void> {
  const executables: string[] = [];
  for (const file of files) {
    const destination = `${target}/${file.path}`;
    if (sandbox.writeFileBytes) await sandbox.writeFileBytes(destination, file.bytes);
    else await writeViaExec(sandbox, destination, file.bytes);
    if (file.executable) executables.push(destination);
  }
  if (executables.length > 0) {
    const result = await runInTask(sandbox, `chmod +x ${executables.map(shellQuote).join(" ")}`, { workdir: null });
    if (result.exitCode !== 0) throw new Error(`chmod failed: ${result.output}`);
  }
}

export type HarborRewards = Record<string, number>;

/** Harbor's reward parsing: reward.json wins, then reward.txt; values must be finite numbers. */
export function parseRewards(kind: "json" | "text", content: string): HarborRewards {
  if (content.trim() === "") throw new Error(`Reward ${kind} file is empty`);
  if (kind === "text") {
    const value = Number(content.trim());
    if (!Number.isFinite(value)) throw new Error(`Non-finite reward ${JSON.stringify(content.trim())}`);
    return { reward: value };
  }
  const parsed = JSON.parse(content) as unknown;
  const entries = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? Object.entries(parsed as Record<string, unknown>)
    : [["reward", parsed] as const];
  const rewards: HarborRewards = {};
  for (const [key, value] of entries) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Non-numeric or non-finite reward ${JSON.stringify(value)} for ${key}`);
    }
    rewards[key] = value;
  }
  return rewards;
}

export interface HarborVerification {
  rewards: HarborRewards;
  testExitCode: number;
  testOutputTail: string;
}

export interface TaskRuntime {
  /** The image's WORKDIR; Harbor runs commands there. */
  workdir: string | null;
  /** The image's ENV, which Harbor's docker exec inherits. */
  env: Record<string, string>;
}

async function readTail(sandbox: HarborTrialSandbox, path: string, runtime: TaskRuntime): Promise<string> {
  const result = await runInTask(sandbox, `tail -c 4000 ${shellQuote(path)} 2>/dev/null || true`, { workdir: null, env: runtime.env });
  return result.output;
}

export async function prepareHarborDirectories(sandbox: HarborTrialSandbox, runtime: TaskRuntime): Promise<void> {
  const dirs = [HARBOR_PATHS.agentDir, HARBOR_PATHS.verifierDir, HARBOR_PATHS.artifactsDir].map(shellQuote).join(" ");
  const result = await runInTask(sandbox, `mkdir -p ${dirs} && chmod 777 ${dirs}`, { workdir: null, env: runtime.env });
  if (result.exitCode !== 0) throw new Error(`Could not create Harbor log directories: ${result.output}`);
}

/** Harbor OracleAgent: upload solution/, run solve.sh in the task workdir. */
export async function runOracle(task: HarborTask, sandbox: HarborTrialSandbox, runtime: TaskRuntime): Promise<ShellResult> {
  if (!task.solution) throw new Error(`Harbor task ${task.name} has no solution/solve.sh`);
  await uploadFiles(sandbox, task.solution, HARBOR_PATHS.solutionDir);
  await runInTask(sandbox, `chmod +x ${HARBOR_PATHS.solutionDir}/solve.sh`, { workdir: null });
  return runInTask(
    sandbox,
    `${HARBOR_PATHS.solutionDir}/solve.sh > ${HARBOR_PATHS.oracleLog} 2>&1`,
    {
      workdir: runtime.workdir,
      env: { ...runtime.env, ...task.solutionEnv },
      ...(task.agentTimeoutSec === null ? {} : { timeoutMs: task.agentTimeoutSec * 1000 }),
    },
  );
}

/**
 * Harbor Verifier: tests/ is uploaded only now, after the agent finished,
 * then test.sh runs in the task workdir and writes /logs/verifier/reward.*.
 */
export async function verifyHarborTask(task: HarborTask, sandbox: HarborTrialSandbox, runtime: TaskRuntime): Promise<HarborVerification> {
  await uploadFiles(sandbox, task.tests, HARBOR_PATHS.testsDir);
  await runInTask(sandbox, `chmod +x ${HARBOR_PATHS.testsDir}/test.sh`, { workdir: null });
  const test = await runInTask(
    sandbox,
    `${HARBOR_PATHS.testsDir}/test.sh > ${HARBOR_PATHS.testStdout} 2>&1`,
    { workdir: runtime.workdir, env: { ...runtime.env, ...task.verifierEnv }, timeoutMs: task.verifierTimeoutSec * 1000 },
  );
  return readHarborVerification(sandbox, runtime, test.exitCode);
}

/** Read reward.json / reward.txt and the test output tail after test.sh exited. */
export async function readHarborVerification(sandbox: HarborTrialSandbox, runtime: TaskRuntime, testExitCode: number): Promise<HarborVerification> {
  // Provider adapters differ in how they frame multi-line output, so the
  // reward file travels as one base64 token between markers.
  const probe = await runInTask(
    sandbox,
    `if [ -f ${HARBOR_PATHS.rewardJson} ]; then k=json; f=${HARBOR_PATHS.rewardJson}; `
      + `elif [ -f ${HARBOR_PATHS.rewardText} ]; then k=text; f=${HARBOR_PATHS.rewardText}; `
      + `else k=none; f=/dev/null; fi; printf '${REWARD_MARKER}%s:%s${REWARD_END}' "$k" "$(base64 < "$f" | tr -d '\\n')"`,
    { workdir: null, env: runtime.env },
  );
  const match = new RegExp(`${REWARD_MARKER}(json|text|none):([A-Za-z0-9+/=]*)${REWARD_END}`).exec(probe.output);
  if (!match) throw new Error(`Could not read the reward file: ${probe.output.slice(-500)}`);
  const testOutputTail = await readTail(sandbox, HARBOR_PATHS.testStdout, runtime);
  if (match[1] === "none") {
    throw Object.assign(new Error(`No reward file found at ${HARBOR_PATHS.rewardText} or ${HARBOR_PATHS.rewardJson}`), { testOutputTail });
  }
  return {
    rewards: parseRewards(match[1] as "json" | "text", new TextDecoder().decode(fromBase64(match[2]!))),
    testExitCode,
    testOutputTail,
  };
}

/**
 * The directory an OMA agent must start in for a Harbor trial: the image's
 * WORKDIR, which OMA adopts as the workspace root (ADR 0016). An image
 * without one runs in `/` under Harbor but in `/workspace` under OMA, so
 * scores would not be comparable: such tasks are refused, not run elsewhere.
 */
export function requireAgentWorkdir(task: Pick<HarborTask, "name">, workingDir: string | null): string {
  const workdir = workingDir?.replace(/\/+$/u, "") ?? "";
  if (workdir === "") throw new UnsupportedHarborTaskError(task.name, "image declares no WORKDIR");
  return workdir;
}

// ── Detached steps ──────────────────────────────────────────────────────────
// A tick-driven runner (cron on Cloudflare, scheduler on Node) cannot hold one
// request open for a 10-minute test.sh. These run a step in the background
// inside the sandbox and record its exit status under the platform root
// (ADR 0016), so later ticks can poll it.

export type DetachedStepId = "oracle" | "verifier";
export const DETACHED_STATE_DIR = "/oma/eval";

function stepFile(step: DetachedStepId, suffix: "exit" | "pid"): string {
  return `${DETACHED_STATE_DIR}/${step}.${suffix}`;
}

export async function startDetached(
  sandbox: HarborTrialSandbox,
  step: DetachedStepId,
  command: string,
  options: { workdir: string | null; env?: Record<string, string> },
): Promise<void> {
  const exports = Object.entries(options.env ?? {})
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
      return `export ${key}=${shellQuote(value)}; `;
    })
    .join("");
  const cd = options.workdir ? `cd ${shellQuote(options.workdir)} && ` : "";
  const inner = `${exports}${cd}( ${command} ); echo $? > ${stepFile(step, "exit")}`;
  const launch = `mkdir -p ${DETACHED_STATE_DIR} && rm -f ${stepFile(step, "exit")} ${stepFile(step, "pid")}`
    + ` && (nohup bash -c ${shellQuote(inner)} > /dev/null 2>&1 < /dev/null & echo $! > ${stepFile(step, "pid")})`;
  const result = await runInTask(sandbox, launch, { workdir: null });
  if (result.exitCode !== 0) throw new Error(`Could not start ${step}: ${result.output.slice(0, 300)}`);
}

export async function pollDetached(sandbox: HarborTrialSandbox, step: DetachedStepId): Promise<{ done: false } | { done: true; exitCode: number }> {
  const result = await runInTask(sandbox, `cat ${stepFile(step, "exit")} 2>/dev/null || true`, { workdir: null });
  const value = result.output.trim();
  if (value === "") return { done: false };
  const exitCode = Number.parseInt(value, 10);
  if (!Number.isFinite(exitCode)) throw new Error(`Unreadable ${step} exit status ${JSON.stringify(value)}`);
  return { done: true, exitCode };
}

/** Stop a detached step and its children (timeout or cancellation). */
export async function killDetached(sandbox: HarborTrialSandbox, step: DetachedStepId): Promise<void> {
  const pid = stepFile(step, "pid");
  await runInTask(
    sandbox,
    `if [ -f ${pid} ]; then p=$(cat ${pid}); pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; fi; true`,
    { workdir: null },
  );
}

/** Upload tests/ (only now, after the agent) and start test.sh in the background. */
export async function startHarborVerifier(task: HarborTask, sandbox: HarborTrialSandbox, runtime: TaskRuntime): Promise<void> {
  await prepareHarborDirectories(sandbox, runtime);
  await uploadFiles(sandbox, task.tests, HARBOR_PATHS.testsDir);
  await runInTask(sandbox, `chmod +x ${HARBOR_PATHS.testsDir}/test.sh`, { workdir: null });
  await startDetached(sandbox, "verifier", `${HARBOR_PATHS.testsDir}/test.sh > ${HARBOR_PATHS.testStdout} 2>&1`, {
    workdir: runtime.workdir,
    env: { ...runtime.env, ...task.verifierEnv },
  });
}

/** Upload solution/ and start solve.sh in the background (Harbor OracleAgent). */
export async function startHarborOracle(task: HarborTask, sandbox: HarborTrialSandbox, runtime: TaskRuntime): Promise<void> {
  if (!task.solution) throw new Error(`Harbor task ${task.name} has no solution/solve.sh`);
  await prepareHarborDirectories(sandbox, runtime);
  await uploadFiles(sandbox, task.solution, HARBOR_PATHS.solutionDir);
  await runInTask(sandbox, `chmod +x ${HARBOR_PATHS.solutionDir}/solve.sh`, { workdir: null });
  await startDetached(sandbox, "oracle", `${HARBOR_PATHS.solutionDir}/solve.sh > ${HARBOR_PATHS.oracleLog} 2>&1`, {
    workdir: runtime.workdir,
    env: { ...runtime.env, ...task.solutionEnv },
  });
}
