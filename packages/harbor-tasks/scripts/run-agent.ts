/**
 * Agent run for #531: each Harbor task runs as a real OMA managed Session.
 * The task image comes from the operator SANDBOX_IMAGES catalog (alias = task
 * name), the agent receives instruction.md as its first user.message, and
 * once the Session is idle the verifier runs in the same Session sandbox
 * through POST /v1/oma/sessions/:id/sandbox/exec.
 *
 *   OMA_BASE_URL=http://127.0.0.1:8788 OMA_API_KEY=... pnpm exec tsx scripts/run-agent.ts \
 *     --tasks-dir ~/.cache/harbor/terminal-bench --agent agent_xxx --task fix-git \
 *     --out results.jsonl --trajectories-dir trajectories/ --concurrency 2
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  fetchImageRuntimeConfig,
  prepareHarborDirectories,
  requireAgentWorkdir,
  runInTask,
  shellQuote,
  verifyHarborTask,
  type HarborTrialSandbox,
} from "../src/index";
import { loadHarborTask } from "../src/node";

interface Args {
  tasksDir: string; tasks: string[]; agent: string; out: string | null;
  trajectoriesDir: string | null; concurrency: number; keepSessions: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { tasksDir: "", tasks: [], agent: "", out: null, trajectoriesDir: null, concurrency: 1, keepSessions: false };
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
    else if (flag === "--agent") args.agent = value();
    else if (flag === "--out") args.out = resolve(value());
    else if (flag === "--trajectories-dir") args.trajectoriesDir = resolve(value());
    else if (flag === "--concurrency") args.concurrency = Math.max(1, Number.parseInt(value(), 10));
    else if (flag === "--keep-sessions") args.keepSessions = true;
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!args.tasksDir || !args.agent || args.tasks.length === 0) throw new Error("--tasks-dir, --agent and at least one --task are required");
  return args;
}

const baseUrl = (process.env.OMA_BASE_URL ?? "").replace(/\/+$/, "");
const apiKey = process.env.OMA_API_KEY ?? "";
if (!baseUrl || !apiKey) throw new Error("OMA_BASE_URL and OMA_API_KEY are required");

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { "x-api-key": apiKey, "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface SessionEvent { id?: string; type: string; stop_reason?: { type?: string }; [key: string]: unknown }

async function listEvents(sessionId: string): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  let page: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "1000", ...(page === null ? {} : { page }) });
    const result = await api<{ data: SessionEvent[]; next_page?: string | null }>("GET", `/v1/sessions/${sessionId}/events?${query}`);
    events.push(...result.data);
    page = result.next_page ?? null;
  } while (page !== null);
  return events;
}

/** Wait for the idle (or terminal) status that follows our user.message. */
async function waitForIdle(sessionId: string, messageId: string, deadline: number | null): Promise<{ events: SessionEvent[]; timedOut: boolean }> {
  for (;;) {
    const events = await listEvents(sessionId);
    const at = events.findIndex((event) => event.id === messageId);
    const after = at < 0 ? [] : events.slice(at + 1);
    const settled = after.some((event) =>
      (event.type === "session.status_idle" && event.stop_reason?.type !== "requires_action")
      || event.type === "session.status_terminated");
    if (settled) return { events, timedOut: false };
    if (deadline !== null && Date.now() > deadline) return { events, timedOut: true };
    await sleep(5_000);
  }
}

/** HarborTrialSandbox over the Session-bound sandbox exec endpoint. */
function sessionSandbox(sessionId: string): HarborTrialSandbox {
  const execOnce = async (command: string, timeout: number): Promise<string> => {
    const result = await api<{ exit_code: number; output: string }>("POST", `/v1/oma/sessions/${sessionId}/sandbox/exec`, { command, timeout_ms: timeout });
    return `exit=${result.exit_code}\n${result.output}`;
  };
  // Node's fetch gives up waiting for response headers after 300s, shorter
  // than some verifier timeouts. Long commands run detached in the sandbox
  // and are polled, so no single HTTP request outlives that limit.
  const exec = async (command: string, timeout = 60_000): Promise<string> => {
    if (timeout <= 120_000) return execOnce(command, timeout);
    const base = `/tmp/oma-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const started = await execOnce(
      `(nohup sh -c ${shellQuote(command)} > ${base}.out 2>&1; echo $? > ${base}.rc) > /dev/null 2>&1 < /dev/null &`, 30_000);
    if (!started.startsWith("exit=0\n")) return started;
    const deadline = Date.now() + timeout + 30_000;
    while (Date.now() < deadline) {
      await sleep(5_000);
      const rc = await execOnce(`cat ${base}.rc 2>/dev/null`, 30_000);
      const code = /^exit=0\n\s*(-?\d+)\s*$/u.exec(rc)?.[1];
      if (code === undefined) continue;
      const output = await execOnce(`cat ${base}.out; rm -f ${base}.out ${base}.rc`, 60_000);
      return `exit=${code}\n${output.replace(/^exit=\d+\n/u, "")}`;
    }
    throw new Error(`sandbox command did not finish within ${timeout}ms`);
  };
  const writeFileBytes = async (path: string, bytes: Uint8Array): Promise<void> => {
    const encoded = Buffer.from(bytes).toString("base64");
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const chunk = 48_000;
    for (let offset = 0; offset === 0 || offset < encoded.length; offset += chunk) {
      const part = encoded.slice(offset, offset + chunk);
      const redirect = offset === 0 ? ">" : ">>";
      const raw = await exec(`mkdir -p ${shellQuote(dir)} && printf '%s' ${shellQuote(part)} | base64 -d ${redirect} ${shellQuote(path)}`);
      if (!raw.startsWith("exit=0\n")) throw new Error(`Upload of ${path} failed: ${raw.slice(0, 300)}`);
    }
  };
  return {
    exec,
    writeFileBytes,
    writeFile: (path, content) => writeFileBytes(path, Buffer.from(content, "utf8")),
  };
}

interface TrialRecord {
  task: string; ok: boolean; reward: number | null; rewards: Record<string, number> | null;
  sessionId: string | null; agentTimedOut: boolean; stopReason: string | null;
  toolCalls: number; agentMessages: number; testExitCode: number | null;
  workdir: string | null; agentSeconds: number; durationMs: number; error?: string; testOutputTail?: string;
}

async function runTask(args: Args, name: string): Promise<TrialRecord> {
  const started = Date.now();
  const record: TrialRecord = {
    task: name, ok: false, reward: null, rewards: null, sessionId: null, agentTimedOut: false, stopReason: null,
    toolCalls: 0, agentMessages: 0, testExitCode: null, workdir: null, agentSeconds: 0, durationMs: 0,
  };
  let sessionId: string | null = null;
  try {
    const task = await loadHarborTask(join(args.tasksDir, name), name);
    // Registry reads are flaky from some networks (ETIMEDOUT); retry before
    // counting the task as failed.
    let image: Awaited<ReturnType<typeof fetchImageRuntimeConfig>> | undefined;
    for (let attempt = 1; image === undefined; attempt++) {
      try { image = await fetchImageRuntimeConfig(task.image); }
      catch (error) { if (attempt >= 3) throw error; await sleep(3_000); }
    }
    record.workdir = requireAgentWorkdir(task, image.workingDir);
    const environment = await api<{ id: string }>("POST", "/v1/environments", {
      name: `harbor-${name}-${started}`,
      config: { type: "cloud", networking: { type: "unrestricted" } },
      _oma: { sandbox_image: name },
    });
    const session = await api<{ id: string }>("POST", "/v1/sessions", { agent: args.agent, environment_id: environment.id, title: `harbor ${name}` });
    sessionId = session.id;
    record.sessionId = sessionId;
    const sent = await api<{ data?: Array<{ id: string }> }>("POST", `/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: task.instruction }] }],
    });
    const messageId = sent.data?.[0]?.id;
    if (!messageId) throw new Error("user.message was not acknowledged with an event id");
    const agentStarted = Date.now();
    const deadline = task.agentTimeoutSec === null ? null : agentStarted + task.agentTimeoutSec * 1000;
    let waited = await waitForIdle(sessionId, messageId, deadline);
    if (waited.timedOut) {
      // Harbor stops the agent at its timeout and still runs the verifier.
      record.agentTimedOut = true;
      await api("POST", `/v1/sessions/${sessionId}/events`, { events: [{ type: "user.interrupt" }] });
      waited = await waitForIdle(sessionId, messageId, Date.now() + 120_000);
    }
    record.agentSeconds = Math.round((Date.now() - agentStarted) / 1000);
    const events = waited.events;
    record.toolCalls = events.filter((event) => event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use").length;
    record.agentMessages = events.filter((event) => event.type === "agent.message").length;
    record.stopReason = [...events].reverse().find((event) => event.type === "session.status_idle")?.stop_reason?.type ?? null;
    if (args.trajectoriesDir) {
      await mkdir(args.trajectoriesDir, { recursive: true });
      await writeFile(join(args.trajectoriesDir, `${name}.json`), JSON.stringify(events, null, 2));
    }
    const sandbox = sessionSandbox(sessionId);
    // ADR 0016: the session's commands run in the workspace root, which must
    // be the image WORKDIR; a mismatch means the trial ran somewhere else.
    const probe = (await runInTask(sandbox, `printf '__OMA_PWD__%s__OMA_PWD__' "$(pwd)"`, { workdir: null })).output;
    const observed = /__OMA_PWD__(.*?)__OMA_PWD__/su.exec(probe)?.[1] ?? probe;
    if (observed !== record.workdir) throw new Error(`agent workspace root is ${observed}, image WORKDIR is ${record.workdir}`);
    const runtime = { workdir: image.workingDir, env: image.env };
    await prepareHarborDirectories(sandbox, runtime);
    const verification = await verifyHarborTask(task, sandbox, runtime);
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
    if (sessionId !== null && !args.keepSessions) await api("DELETE", `/v1/sessions/${sessionId}`).catch(() => undefined);
    record.durationMs = Date.now() - started;
  }
  return record;
}

const args = parseArgs(process.argv.slice(2));
const queue = [...args.tasks];
const records: TrialRecord[] = [];
await Promise.all(Array.from({ length: Math.min(args.concurrency, queue.length) }, async () => {
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const record = await runTask(args, name);
    records.push(record);
    console.log(JSON.stringify({ task: record.task, ok: record.ok, reward: record.reward, tools: record.toolCalls, timedOut: record.agentTimedOut, error: record.error, seconds: Math.round(record.durationMs / 1000) }));
    if (args.out) await appendFile(args.out, JSON.stringify(record) + "\n");
  }
}));
const passed = records.filter((record) => record.ok).length;
console.log(JSON.stringify({ summary: { total: records.length, passed, score: records.length === 0 ? 0 : passed / records.length } }));
