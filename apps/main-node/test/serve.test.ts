import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { serveNodeControlPlane, type NodeServer } from "../src/serve";

const created: NodeControlPlane[] = [];
const servers: NodeServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function controlPlane(): Promise<NodeControlPlane> {
  const dir = mkdtempSync(join(tmpdir(), "oma-serve-"));
  dirs.push(dir);
  const cp = await createNodeControlPlane(loadNodeConfig({
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
  }));
  created.push(cp);
  return cp;
}

describe("serveNodeControlPlane", () => {
  it("listens on the requested host and an OS-assigned port and serves the control plane", async () => {
    const cp = await controlPlane();
    const server = await serveNodeControlPlane(cp, { host: "127.0.0.1", port: 0 });
    servers.push(server);

    expect(server.address.host).toBe("127.0.0.1");
    expect(server.address.port).toBeGreaterThan(0);
    const response = await fetch(`http://${server.address.host}:${server.address.port}/health`);
    expect(response.status).toBe(200);
    expect((await response.json() as { status: string }).status).toBe("ok");
  });

  it("does not install signal handlers unless asked, and removes them on close", async () => {
    const cp = await controlPlane();
    const before = process.listenerCount("SIGTERM");

    const plain = await serveNodeControlPlane(cp, { host: "127.0.0.1", port: 0 });
    expect(process.listenerCount("SIGTERM")).toBe(before);
    await plain.close();

    const exit = vi.fn();
    const withSignals = await serveNodeControlPlane(cp, { host: "127.0.0.1", port: 0, signals: { exit } });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
    await withSignals.close();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("on a signal, stops the control plane before exiting the process", async () => {
    const cp = await controlPlane();
    const order: string[] = [];
    const originalStop = cp.stop.bind(cp);
    (cp as { stop: NodeControlPlane["stop"] }).stop = async (signal) => { order.push(`stop:${signal}`); await originalStop(signal); };
    const exit = vi.fn((code: number) => { order.push(`exit:${code}`); });

    const server = await serveNodeControlPlane(cp, { host: "127.0.0.1", port: 0, signals: { exit } });
    servers.push(server);
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(order).toEqual(["stop:SIGTERM", "exit:0"]);
  });
});
