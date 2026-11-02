/**
 * Chaos tests for sandbox loss (ADR 0005 failure semantics):
 *
 *   Sandbox disappears   -> reacquire, restore the last committed workspace,
 *                           continue from the Session event history
 *   Runtime resume fails -> cold acquire plus workspace restore
 *   Lease renewal fails  -> probe; a live sandbox keeps working, a lost one
 *                           is replaced
 *
 * Every seed drives several turns through the real runner, the SQL execution
 * fence and the real checkpoint service, while a seeded chaos monkey kills
 * sandboxes between turns, while they are prepared, during tool calls, during
 * lease renewal and during the turn barrier, and makes acquisitions and
 * renewals fail transiently. Invariants are checked after every turn.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { NodeManagedWorkspaceCheckpoints } from "../../../packages/control-plane-node/src/lib/node-managed-workspace-checkpoints.js";
import { DefaultNodeManagedSessionRunner } from "../../../packages/control-plane-node/src/lib/node-managed-session-runner.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** mulberry32: small, seedable, good enough to pick chaos points. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOST = "Sandbox is probably not running anymore";

/** A file-backed sandbox with the provider runtime Port that can be killed. */
class ChaosSandbox {
  dead = false;
  destroyed = false;
  renewFailures = 0;
  readonly renewals: number[] = [];
  /** Calls that reached this sandbox after it died. */
  callsAfterDeath = 0;
  readonly deadCalls: string[] = [];
  phase: () => string = () => "";
  onCall: (sandbox: ChaosSandbox, method: string) => void = () => {};

  private constructor(readonly id: string, private readonly root: string) {}

  static async create(id: string): Promise<ChaosSandbox> {
    const root = await mkdtemp(join(tmpdir(), "oma-chaos-sandbox-"));
    roots.push(root);
    await mkdir(join(root, "workspace"));
    await mkdir(join(root, "tmp"));
    await mkdir(join(root, "var-tmp"));
    return new ChaosSandbox(id, root);
  }

  private rewrite(text: string, anchored: boolean): string {
    const dirs: Record<string, string> = { "/workspace": "workspace", "/var/tmp": "var-tmp", "/tmp": "tmp" };
    return text.replace(
      anchored ? /^(\/workspace|\/var\/tmp|\/tmp)\b/ : /(\/workspace|\/var\/tmp|\/tmp)\b/g,
      (dir) => join(this.root, dirs[dir]!),
    );
  }

  private enter(method: string): void {
    this.onCall(this, method);
    if (this.dead) {
      this.callsAfterDeath += 1;
      this.deadCalls.push(`${method}@${this.phase()}`);
      throw new Error(LOST);
    }
  }

  async exec(command: string): Promise<string> {
    this.enter("exec");
    const result = spawnSync("/bin/sh", ["-c", this.rewrite(command, false)], { encoding: "utf8" });
    return result.status === 0 ? result.stdout : `${result.stderr}[exit ${result.status}]`;
  }
  async readFile(name: string): Promise<string> {
    this.enter("readFile");
    return readFile(this.rewrite(name, true), "utf8");
  }
  async readFileBytes(name: string): Promise<Uint8Array> {
    this.enter("readFileBytes");
    return new Uint8Array(await readFile(this.rewrite(name, true)));
  }
  async writeFile(name: string, content: string): Promise<string> {
    this.enter("writeFile");
    await writeFile(this.rewrite(name, true), content);
    return name;
  }
  async writeFileBytes(name: string, content: Uint8Array): Promise<string> {
    this.enter("writeFileBytes");
    await writeFile(this.rewrite(name, true), content);
    return name;
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.dead = true;
  }
  /** What the agent sees in /workspace, read directly (not a sandbox call). */
  async files(): Promise<string[]> {
    return (await readdir(join(this.root, "workspace"))).filter((name) => !name.startsWith(".")).sort();
  }
  runtimeHandle() { return { provider: "chaos", runtimeId: this.id }; }
  runtimeCapabilities() { return { lease: true, suspend: [], checkpoint: [] }; }
  async status() {
    if (this.dead) throw new Error(`healthy sandbox not found: ${this.id}`);
    return "running" as const;
  }
  async renewLease(input: { ttlMs: number }) {
    this.onCall(this, "renewLease");
    if (this.renewFailures > 0) {
      this.renewFailures -= 1;
      throw new Error("renew: upstream timeout");
    }
    if (this.dead) throw new Error(`sandbox ${this.id} not found`);
    this.renewals.push(input.ttlMs);
  }
  async suspend(): Promise<never> { throw new Error("unsupported"); }
  async resume(): Promise<void> {}
  async checkpoint(): Promise<never> { throw new Error("unsupported"); }
}

const scope = { workspaceId: "workspace_chaos", environmentId: "env_chaos", sessionId: "session_chaos", workId: "exec_1" };

async function fencedCheckpoints() {
  const root = await mkdtemp(join(tmpdir(), "oma-chaos-sql-"));
  roots.push(root);
  const sql = await createBetterSqlite3SqlClient(join(root, "chaos.db"));
  await ensureSessionExecutionCoordinatorSchema(sql);
  const coordinator = new SqlSessionExecutionCoordinator(sql);
  const now = Date.now();
  await coordinator.admit({ execution: {
    id: scope.workId, workspaceId: scope.workspaceId, sessionId: scope.sessionId,
    admittedAt: new Date(now - 100).toISOString(),
    events: [{ id: "event_0", type: "user.message", content: [{ type: "text", text: "go" }] }] as never,
  } });
  const claim = await coordinator.claim({
    workspaceId: scope.workspaceId, sessionId: scope.sessionId,
    ownerId: "replica_a", attemptId: "attempt_1", claimedAt: new Date(now).toISOString(), leaseTtlMs: 600_000,
  });
  if (claim.type !== "claimed") throw new Error("Expected claimed execution");
  // Every successful turn is a checkpoint barrier: the interval is always due.
  const checkpoints = new NodeManagedWorkspaceCheckpoints({
    sql, blobs: new InMemoryBlobStore(), intervalMs: 1, nowMs: () => Date.now() + 10_000,
  });
  await checkpoints.ensureSchema();
  return { checkpoints, fence: claim.fence };
}

interface ChaosRates {
  /** Kill the warm sandbox before a turn starts. */
  betweenTurns: number;
  /** Kill the sandbox at a sandbox call made by a tool. */
  duringTool: number;
  /** Kill the sandbox while it is being prepared (after restore). */
  duringPrepare: number;
  /** Kill the sandbox during the turn barrier (memory/output sync). */
  duringBarrier: number;
  /** The provider fails to create a sandbox. */
  acquireFails: number;
  /** A lease renewal times out while the sandbox is fine. */
  renewBlip: number;
  /** The sandbox dies right before a lease renewal. */
  diesAtRenew: number;
}

interface TurnRecord {
  ok: boolean;
  replacedErrors: string[];
  idleEvents: number;
  errorEvents: number;
  lastEventType: string | undefined;
}

async function runChaos(seed: number, turns: number, rates: ChaosRates) {
  const random = prng(seed);
  // Lease renewals happen on a timer; their own stream keeps the other chaos
  // points reproducible for a seed.
  const renewRandom = prng(seed ^ 0x5bd1e995);
  const { checkpoints, fence } = await fencedCheckpoints();
  const sandboxes: ChaosSandbox[] = [];
  /** Files the last published checkpoint contains (the oracle). */
  let committed: string[] = [];
  const restoreViolations: string[] = [];
  let chaosEnabled = true;
  let inBarrier = false;
  let phase = "";
  let acquisitions = 0;
  let turn = { index: -1, replacedErrors: [] as string[] };

  const maybe = (rate: number) => chaosEnabled && random() < rate;
  const maybeAtRenew = (rate: number) => chaosEnabled && renewRandom() < rate;

  const onCall = (sandbox: ChaosSandbox, method: string) => {
    if (sandbox.dead) return;
    if (method === "renewLease") {
      if (maybeAtRenew(rates.renewBlip)) sandbox.renewFailures += 1;
      else if (maybeAtRenew(rates.diesAtRenew)) sandbox.dead = true;
      return;
    }
    if (inBarrier && maybe(rates.duringBarrier)) sandbox.dead = true;
  };

  const runner = new DefaultNodeManagedSessionRunner({
    workspaceCheckpoints: checkpoints,
    harnessRetry: { attempts: 1, delayMs: () => 0 },
    probeSandbox: async (candidate) => {
      try {
        await (candidate as unknown as ChaosSandbox).status();
        return "alive";
      } catch {
        return "lost";
      }
    },
    sandboxLease: { ttlMs: 60, intervalMs: 3 },
    buildSandbox: async () => {
      acquisitions += 1;
      if (maybe(rates.acquireFails)) throw new Error("provider: capacity exhausted");
      const sandbox = await ChaosSandbox.create(`sb${acquisitions}`);
      sandbox.onCall = onCall;
      sandbox.phase = () => phase;
      sandboxes.push(sandbox);
      return sandbox as unknown as SandboxExecutor;
    },
    prepareSandbox: async ({ sandbox }) => {
      phase = "prepare";
      const chaos = sandbox as unknown as ChaosSandbox;
      // The workspace has been restored before inputs are staged: it must be
      // exactly the last committed checkpoint, never empty, never newer.
      const files = await chaos.files();
      if (JSON.stringify(files) !== JSON.stringify(committed)) {
        restoreViolations.push(`${chaos.id}: restored ${JSON.stringify(files)}, committed ${JSON.stringify(committed)}`);
      }
      if (maybe(rates.duringPrepare)) chaos.dead = true;
      await chaos.writeFile("/workspace/.prepared", chaos.id);
    },
    synchronizeSandbox: async ({ sandbox }) => {
      inBarrier = true;
      phase = "barrier";
      try {
        await (sandbox as unknown as ChaosSandbox).exec("true");
      } finally {
        inBarrier = false;
      }
    },
    outcomes: { evaluate: async () => { throw new Error("unexpected"); } },
    confirmedTools: { execute: async () => { throw new Error("unexpected"); } },
    buildModel: async () => ({} as never),
    buildTools: async () => ({}),
    // The "agent": writes one file per step through the sandbox tools see and
    // reads it back; like a model, it redoes a step after being told the
    // sandbox was replaced, and stops when recovery gives up.
    buildHarness: () => ({ run: async (context: any) => {
      phase = "harness";
      const sandbox = context.sandbox as SandboxExecutor;
      for (let step = 0; step < 3; step++) {
        const name = `/workspace/t${turn.index}-s${step}.txt`;
        for (let attempt = 0; ; attempt++) {
          try {
            if (maybe(rates.duringTool)) {
              const current = runner.connectedSandbox(scope) as unknown as ChaosSandbox | null;
              if (current !== null) current.dead = true;
            }
            await sandbox.writeFile(name, `turn ${turn.index} step ${step}`);
            expect(await sandbox.readFile(name)).toBe(`turn ${turn.index} step ${step}`);
            break;
          } catch (error) {
            if ((error as Error).name !== "SandboxReplacedError" || attempt > 5) throw error;
            turn.replacedErrors.push((error as Error).message);
            // Files from earlier steps of this turn were not committed and
            // are gone with the lost sandbox; redo them as an agent would.
            step = -1;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    } }),
    buildHarnessContext: async (input: any) => input,
    clock: { now: () => new Date() },
    ids: { nextEventId: (() => { let n = 0; return () => `evt_${++n}`; })() },
  });

  const base = {
    workspaceId: scope.workspaceId, sessionId: scope.sessionId,
    session: { id: scope.sessionId, resources: [], agent: { skills: [] } } as never,
    environment: { id: scope.environmentId, config: {} } as never,
    initialEvents: [], executionFence: fence,
  };

  /** The execution driver retries a failed start (3 attempts by default). */
  const start = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await runner.start(base);
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
      }
    }
  };

  const records: TurnRecord[] = [];
  const runTurn = async (index: number): Promise<TurnRecord> => {
    if (maybe(rates.betweenTurns)) {
      const warm = runner.connectedSandbox(scope) as unknown as ChaosSandbox | null;
      if (warm !== null) warm.dead = true;
    }
    const events: Array<{ type: string }> = [];
    turn = { index, replacedErrors: [] as string[] };
    try {
      phase = "start";
      await start();
    } catch {
      return { ok: false, replacedErrors: [], idleEvents: 0, errorEvents: 0, lastEventType: undefined };
    }
    const event = { id: `event_${index}`, type: "user.message", content: [{ type: "text", text: `turn ${index}` }] } as never;
    let ok = true;
    try {
      await runner.accept({
        ...base,
        events: [event], historyEvents: [event],
        output: async (frame: any) => { events.push(frame?.event ?? frame); },
      } as never);
    } catch {
      ok = false;
    }
    const current = runner.connectedSandbox(scope) as unknown as ChaosSandbox | null;
    if (ok && current !== null) committed = await current.files();
    const types = events.map((e: any) => e?.type).filter(Boolean) as string[];
    return {
      ok,
      replacedErrors: turn.replacedErrors,
      idleEvents: types.filter((type) => type === "session.status_idle").length,
      errorEvents: types.filter((type) => type === "session.error").length,
      lastEventType: types.at(-1),
    };
  };

  for (let index = 0; index < turns; index++) records.push(await runTurn(index));
  // After the chaos stops, the Session must make progress again.
  chaosEnabled = false;
  const final = await runTurn(turns);
  records.push(final);
  return { records, sandboxes, restoreViolations, committed, runner, final };
}

function checkInvariants(result: Awaited<ReturnType<typeof runChaos>>, seed: number) {
  const where = `seed ${seed}`;
  const { records, sandboxes, restoreViolations, runner, final } = result;
  // 1. Every replacement restored exactly the last committed workspace.
  expect(restoreViolations.join("\n"), where).toBe("");
  // 2. No sandbox call reached a sandbox after it had been replaced: only the
  //    call that discovered the loss touches a dead sandbox.
  const current = runner.connectedSandbox(scope) as unknown as ChaosSandbox | null;
  for (const sandbox of sandboxes) {
    if (sandbox === current) continue;
    expect(sandbox.callsAfterDeath, `${where}: ${sandbox.id} used after loss ${sandbox.deadCalls.join(",")}`).toBeLessThanOrEqual(1);
  }
  // 3. Nothing leaks: every sandbox except the current one was destroyed.
  for (const sandbox of sandboxes) {
    if (sandbox !== current) expect(sandbox.destroyed, `${where}: ${sandbox.id} leaked`).toBe(true);
  }
  for (const record of records) {
    // 4. Every turn that ran ends idle exactly once, as its last event, and a
    //    failed turn says why.
    if (record.idleEvents > 0 || record.lastEventType !== undefined) {
      expect(record.idleEvents, where).toBe(1);
      expect(record.lastEventType, where).toBe("session.status_idle");
      if (!record.ok) expect(record.errorEvents, where).toBeGreaterThanOrEqual(1);
    }
    // 5. The agent is told explicitly what it lost.
    for (const message of record.replacedErrors) {
      expect(message, where).toMatch(/^This tool call was interrupted because the environment restarted\. \/workspace is back to (its state as of \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC|its initial state)/);
      expect(message, where).not.toMatch(/sandbox|not running anymore|checkpoint/i);
    }
  }
  // 6. Liveness: with chaos off the Session recovers and the workspace holds
  //    every file of every successful turn.
  expect(final.ok, `${where}: no recovery after chaos`).toBe(true);
  const okTurns = records.map((record, index) => ({ record, index })).filter(({ record }) => record.ok);
  const expected = new Set(result.committed);
  for (const { index } of okTurns.slice(-1)) {
    for (let step = 0; step < 3; step++) expect(expected.has(`t${index}-s${step}.txt`), where).toBe(true);
  }
  // 7. The heartbeat renewed live sandboxes while turns ran.
  expect(sandboxes.some((sandbox) => sandbox.renewals.length > 0), where).toBe(true);
}

describe("sandbox loss chaos (ADR 0005)", () => {
  it("replaces a warm sandbox the provider reclaimed between turns and restores the committed workspace", async () => {
    const result = await runChaos(1, 3, {
      betweenTurns: 1, duringTool: 0, duringPrepare: 0, duringBarrier: 0,
      acquireFails: 0, renewBlip: 0, diesAtRenew: 0,
    });
    checkInvariants(result, 1);
    expect(result.records.every((record) => record.ok)).toBe(true);
    // One new sandbox per chaos turn; the calm final turn reuses the warm one.
    expect(result.sandboxes.length).toBe(result.records.length - 1);
  });

  it("replaces a sandbox lost during a tool call and tells the agent what was lost", async () => {
    const result = await runChaos(2, 3, {
      betweenTurns: 0, duringTool: 0.3, duringPrepare: 0, duringBarrier: 0,
      acquireFails: 0, renewBlip: 0, diesAtRenew: 0,
    });
    checkInvariants(result, 2);
    expect(result.records.flatMap((record) => record.replacedErrors).length).toBeGreaterThan(0);
  });

  it("keeps a live sandbox through failed renewals and replaces one that died at renewal", async () => {
    const result = await runChaos(3, 4, {
      betweenTurns: 0, duringTool: 0, duringPrepare: 0, duringBarrier: 0,
      acquireFails: 0, renewBlip: 0.3, diesAtRenew: 0.05,
    });
    checkInvariants(result, 3);
  });

  it("fails a turn whose replacement cannot be acquired, then recovers on the next turn", async () => {
    const result = await runChaos(4, 4, {
      betweenTurns: 0, duringTool: 0.4, duringPrepare: 0, duringBarrier: 0,
      acquireFails: 0.6, renewBlip: 0, diesAtRenew: 0,
    });
    checkInvariants(result, 4);
  });

  const seeds = Array.from({ length: 24 }, (_, index) => 1000 + index);
  it.each(seeds)("survives mixed chaos at every point (seed %i)", async (seed) => {
    const result = await runChaos(seed, 5, {
      betweenTurns: 0.3, duringTool: 0.08, duringPrepare: 0.1, duringBarrier: 0.15,
      acquireFails: 0.1, renewBlip: 0.1, diesAtRenew: 0.03,
    });
    checkInvariants(result, seed);
  }, 30_000);
});
