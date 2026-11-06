/**
 * Oracle parity gate for #531: run each Harbor task's own solution through an
 * OMA sandbox provider, then its verifier. Every task must score 1.0; a miss
 * means our environment differs from Harbor's and agent scores would not be
 * comparable.
 *
 *   pnpm --filter @open-managed-agents/harbor-tasks oracle -- \
 *     --tasks-dir ~/.cache/harbor/terminal-bench --task fix-git --task hello-world \
 *     --out results.jsonl --concurrency 2
 *
 * Provider configuration comes from the environment, exactly as main-node
 * reads it (SANDBOX_PROVIDER=opensandbox, OPENSANDBOX_DOMAIN, OPENSANDBOX_API_KEY).
 */
import { appendFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SandboxFactory, SandboxFactoryEnv } from "@open-managed-agents/sandbox";
import {
  fetchImageRuntimeConfig,
  prepareHarborDirectories,
  runOracle,
  verifyHarborTask,
  type HarborTask,
  type HarborTrialSandbox,
} from "../src/index";
import { loadHarborTask } from "../src/node";

interface Args { tasksDir: string; tasks: string[]; limit: number | null; out: string | null; concurrency: number }

function parseArgs(argv: string[]): Args {
  const args: Args = { tasksDir: "", tasks: [], limit: null, out: null, concurrency: 1 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--") continue;
    else if (flag === "--tasks-dir") args.tasksDir = resolve(value());
    else if (flag === "--task") args.tasks.push(value());
    else if (flag === "--limit") args.limit = Number.parseInt(value(), 10);
    else if (flag === "--out") args.out = resolve(value());
    else if (flag === "--concurrency") args.concurrency = Math.max(1, Number.parseInt(value(), 10));
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!args.tasksDir) throw new Error("--tasks-dir is required");
  return args;
}

const PROVIDERS: Record<string, string> = {
  opensandbox: "@open-managed-agents/sandbox-adapter-opensandbox",
};

/** Map task resources onto the provider's own configuration namespace. */
function resourceEnvironment(provider: string, task: HarborTask): Record<string, string> {
  if (provider !== "opensandbox") throw new Error(`No Harbor resource mapping for SANDBOX_PROVIDER=${provider}`);
  return {
    SANDBOX_IMAGE: task.image,
    ...(task.cpus === null ? {} : { OPENSANDBOX_CPU: String(task.cpus) }),
    ...(task.memoryMb === null ? {} : { OPENSANDBOX_MEMORY: `${task.memoryMb}Mi` }),
  };
}

interface TrialRecord {
  task: string;
  image: string;
  ok: boolean;
  reward: number | null;
  rewards: Record<string, number> | null;
  oracleExitCode: number | null;
  testExitCode: number | null;
  workdir: string | null;
  durationMs: number;
  error?: string;
  testOutputTail?: string;
}

async function runTask(dir: string, name: string, provider: string, factory: SandboxFactory): Promise<TrialRecord> {
  const started = Date.now();
  let task: HarborTask | undefined;
  let sandbox: (HarborTrialSandbox & { destroy?(): Promise<void> }) | undefined;
  const record: TrialRecord = {
    task: name, image: "", ok: false, reward: null, rewards: null,
    oracleExitCode: null, testExitCode: null, workdir: null, durationMs: 0,
  };
  try {
    const loaded = await loadHarborTask(dir, name);
    task = loaded;
    record.image = loaded.image;
    const runtime = await fetchImageRuntimeConfig(task.image);
    const workdir = runtime.workingDir;
    record.workdir = workdir;
    const env: SandboxFactoryEnv = { ...process.env, ...resourceEnvironment(provider, loaded) };
    sandbox = await factory({ sessionId: `harbor-${name}-${started}`, workdir: "/tmp", image: { alias: name, reference: loaded.image } }, env) as typeof sandbox;
    const taskRuntime = { workdir, env: runtime.env };
    await prepareHarborDirectories(sandbox!, taskRuntime);
    const oracle = await runOracle(loaded, sandbox!, taskRuntime);
    record.oracleExitCode = oracle.exitCode;
    const verification = await verifyHarborTask(loaded, sandbox!, taskRuntime);
    record.rewards = verification.rewards;
    record.reward = verification.rewards.reward ?? null;
    record.testExitCode = verification.testExitCode;
    record.ok = record.reward === 1;
    if (!record.ok) record.testOutputTail = verification.testOutputTail;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    const tail = (error as { testOutputTail?: string }).testOutputTail;
    if (tail) record.testOutputTail = tail;
  } finally {
    await sandbox?.destroy?.().catch(() => undefined);
    record.durationMs = Date.now() - started;
  }
  return record;
}

const args = parseArgs(process.argv.slice(2));
const provider = (process.env.SANDBOX_PROVIDER ?? "").trim().toLowerCase();
const modulePath = PROVIDERS[provider];
if (!modulePath) throw new Error(`SANDBOX_PROVIDER must be one of: ${Object.keys(PROVIDERS).join(", ")}`);
const { sandboxFactory } = await import(modulePath) as { sandboxFactory: SandboxFactory };

let names = args.tasks.length > 0 ? args.tasks : (await readdir(args.tasksDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
if (args.limit !== null) names = names.slice(0, args.limit);

const queue = [...names];
const records: TrialRecord[] = [];
await Promise.all(Array.from({ length: Math.min(args.concurrency, queue.length) }, async () => {
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const record = await runTask(join(args.tasksDir, name), name, provider, sandboxFactory);
    records.push(record);
    console.log(JSON.stringify({ task: record.task, ok: record.ok, reward: record.reward, error: record.error, seconds: Math.round(record.durationMs / 1000) }));
    if (args.out) await appendFile(args.out, JSON.stringify(record) + "\n");
  }
}));

const passed = records.filter((record) => record.ok).length;
console.log(JSON.stringify({ summary: { total: records.length, passed, failed: records.length - passed } }));
process.exitCode = passed === records.length ? 0 : 1;
