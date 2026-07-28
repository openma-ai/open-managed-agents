import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface ProcessHandle {
  child: ChildProcess;
  port: number;
  dataDir: string;
  logBuf: string[];
}

const REPO_ROOT = resolve(__dirname, "../../..");
const MAIN_NODE_ENTRY = join(REPO_ROOT, "apps/main-node/src/index.ts");
const TSX_BIN = join(REPO_ROOT, "apps/main-node/node_modules/.bin/tsx");

const DREAM_HEADERS = {
  "content-type": "application/json",
  "anthropic-beta": "managed-agents-2026-04-01,dreaming-2026-04-21",
};

describe("main-node /v1/dreams", () => {
  let dataDir: string;
  let h: ProcessHandle | null = null;

  beforeEach(() => {
    dataDir = join(tmpdir(), `oma-test-dreams-${randomBytes(6).toString("hex")}`);
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(async () => {
    if (h) {
      await killHard(h).catch(() => {});
      h = null;
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("runs a dream through the local Node API without an LLM key when dedup curator is enabled", async () => {
    h = await startMainNode({ dataDir });
    const base = `http://localhost:${h.port}/v1`;

    const inputStore = await createMemoryStore(base, "node-dream-input");
    await writeMemory(base, inputStore, "/notes/a.md", "alpha");
    await writeMemory(base, inputStore, "/notes/b.md", "beta");

    const createRes = await fetch(`${base}/dreams`, {
      method: "POST",
      headers: DREAM_HEADERS,
      body: JSON.stringify({
        inputs: [{ type: "memory_store", memory_store_id: inputStore }],
        model: "claude-sonnet-4-6",
        instructions: "dedupe only",
      }),
    });
    if (createRes.status !== 201) {
      throw new Error(`dream create expected 201; got ${createRes.status} ${await createRes.text()}`);
    }
    const created = (await createRes.json()) as {
      id: string;
      status: string;
      outputs: Array<{ type: string; memory_store_id: string }>;
    };
    expect(created.id).toMatch(/^drm-/);
    expect(created.status).toBe("pending");

    const completed = await poll(
      async () => {
        const res = await fetch(`${base}/dreams/${created.id}`, { headers: DREAM_HEADERS });
        expect(res.status).toBe(200);
        return (await res.json()) as {
          status: string;
          outputs: Array<{ type: string; memory_store_id: string }>;
          session_id: string | null;
        };
      },
      (dream) => dream.status === "completed" || dream.status === "failed",
    );

    expect(completed.status).toBe("completed");
    expect(completed.session_id).toMatch(/^sess-/);
    expect(completed.outputs).toHaveLength(1);
    const outputStore = completed.outputs[0].memory_store_id;
    expect(outputStore).toMatch(/^memstore-/);
    expect(outputStore).not.toBe(inputStore);

    const memories = await listMemories(base, outputStore);
    expect(memories.map((m) => m.path).sort()).toEqual(["/notes/a.md", "/notes/b.md"]);
  }, 90_000);
});

async function startMainNode(opts: { dataDir: string }): Promise<ProcessHandle> {
  const port = await pickPort();
  const child = spawn(TSX_BIN, [MAIN_NODE_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: join(opts.dataDir, "oma.db"),
      AUTH_DATABASE_PATH: join(opts.dataDir, "auth.db"),
      SANDBOX_WORKDIR: join(opts.dataDir, "sandboxes"),
      MEMORY_BLOB_DIR: join(opts.dataDir, "memory-blobs"),
      FILES_BLOB_DIR: join(opts.dataDir, "files-blobs"),
      SESSION_OUTPUTS_DIR: join(opts.dataDir, "outputs"),
      AUTH_DISABLED: "1",
      BETTER_AUTH_SECRET: "test-secret-only-for-vitest",
      DREAM_CURATOR_MODE: "dedup",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logBuf: string[] = [];
  child.stdout?.on("data", (b: Buffer) => logBuf.push(b.toString()));
  child.stderr?.on("data", (b: Buffer) => logBuf.push(b.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        await sleep(300);
        return { child, port, dataDir: opts.dataDir, logBuf };
      }
    } catch {
      /* not ready */
    }
    await sleep(200);
  }
  console.error("main-node never became ready. Logs:\n" + logBuf.join(""));
  child.kill("SIGKILL");
  throw new Error(`main-node didn't respond on /health within 30s`);
}

async function createMemoryStore(base: string, name: string): Promise<string> {
  const res = await fetch(`${base}/memory_stores`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function writeMemory(base: string, storeId: string, path: string, content: string) {
  const res = await fetch(`${base}/memory_stores/${storeId}/memories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(201);
}

async function listMemories(base: string, storeId: string): Promise<Array<{ path: string }>> {
  const res = await fetch(`${base}/memory_stores/${storeId}/memories`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<{ path: string }> };
  return body.data;
}

function killHard(handle: ProcessHandle): Promise<void> {
  return new Promise((res) => {
    if (handle.child.exitCode !== null) return res();
    handle.child.once("exit", () => res());
    handle.child.kill("SIGKILL");
  });
}

function pickPort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        rej(new Error("could not pick port"));
      }
    });
  });
}

async function poll<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const interval = opts.intervalMs ?? 50;
  const timeout = opts.timeoutMs ?? 10_000;
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() - start > timeout) {
      throw new Error(`poll timed out after ${timeout}ms; last value ${JSON.stringify(v)}`);
    }
    await sleep(interval);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
