import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoxRunSandbox, sandboxFactory } from "../src/boxrun";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sse(...blocks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function installFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: URL | RequestInfo, init: RequestInit = {}) => handler(String(input), init));
  globalThis.fetch = mock as typeof fetch;
  return mock;
}

describe("BoxRunSandbox", () => {
  it("reattaches by returned box_id and validates ownership without creating on absence", async () => {
    let name = "";
    let exists = true;
    let deleteStatus = 500;
    const fetch = installFetch((url, init) => {
      if (url.endsWith("/boxes") && init.method === "POST") { name = JSON.parse(String(init.body)).name; return json({ box_id: "physical-box" }); }
      if (url.endsWith("/boxes/physical-box") && !init.method) return exists ? json({ box_id: "physical-box", name, status: "stopped" }) : json({}, 404);
      if (init.method === "DELETE") return new Response(null, { status: deleteStatus });
      throw new Error("unexpected request");
    });
    const context = { workspaceId: "tenant", environmentId: "env", sessionId: "session", allocationId: "physical-a", workdir: "/workspace" };
    const env = { BOXRUN_URL: "https://provider.test/v1/tenant" };
    const first = await sandboxFactory(context, env);
    const binding = sandboxFactory.runtimeBinding!;
    const handle = JSON.parse(JSON.stringify(binding.getHandle(first)));
    expect(handle).toEqual({ provider: "boxrun", runtimeId: "physical-box" });
    const resumed = await binding.resume(handle, context, env);
    expect(binding.getHandle(resumed)).toEqual(handle);
    await expect(binding.resume(handle, { ...context, allocationId: "physical-b" }, env)).rejects.toThrow("allocation");
    exists = false;
    await expect(binding.resume(handle, context, env)).rejects.toThrow("HTTP 404");
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await expect(resumed.destroy!()).rejects.toThrow("not confirmed");
    deleteStatus = 202;
    await expect(resumed.destroy!()).rejects.toThrow("not confirmed");
    deleteStatus = 204;
    await resumed.destroy!();
    expect(fetch.mock.calls.at(-1)?.[0]).toContain("?force=true");
  });

  it("isolates factory allocation names and targets delayed deletion by captured box ID", async () => {
    const boxes = new Map<string, string>(); const names: string[] = []; const deleted: string[] = [];
    let finishDelete!: () => void; let markDeleting!: () => void;
    const deletingStarted = new Promise<void>(resolve => { markDeleting = resolve; });
    installFetch(async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/boxes" && init.method === "POST") {
        const name = JSON.parse(String(init.body)).name as string;
        if ([...boxes.values()].includes(name)) return json({ error: "name already exists" }, 409);
        const id = `box-${names.length + 1}`; names.push(name); boxes.set(id, name);
        return json({ box_id: id });
      }
      const id = /\/boxes\/([^/]+)/.exec(path)?.[1];
      if (init.method === "DELETE" && id) {
        deleted.push(id); markDeleting();
        await new Promise<void>(resolve => { finishDelete = resolve; });
        boxes.delete(id); return new Response(null, { status: 204 });
      }
      if (path.endsWith("/exec")) {
        if (!id || !boxes.has(id)) return json({ error: "not found" }, 404);
        return json({ execution_id: "exec" });
      }
      if (path.endsWith("/output")) return sse('event: stdout\ndata: {"data":"b2s="}\n\n', 'event: exit\ndata: {"exit_code":0}\n\n');
      throw new Error(`unexpected ${url}`);
    });
    const context = { sessionId: "same-logical-session", workspaceId: "workspace", environmentId: "env", workdir: "/workspace" };
    const env = { BOXRUN_URL: "http://provider.test" };
    const a = await sandboxFactory({ ...context, allocationId: "runtime_shared_prefix_a" }, env);
    const b = await sandboxFactory({ ...context, allocationId: "runtime_shared_prefix_b" }, env);
    const legacy = await sandboxFactory(context, env);
    await a.exec("initial"); await b.exec("initial"); await legacy.exec("initial");
    expect(names).toHaveLength(3);
    expect(names[0]).not.toBe(names[1]);
    expect(names[0]).toMatch(/^oma-[a-f0-9]{30,32}$/);
    expect(names[2]).toBe("oma-same-logical-session");
    expect(sandboxFactory.capabilities?.allocationIsolation).toBe(true);
    expect(sandboxFactory.runtimeBinding?.provider).toBe("boxrun");
    const deleting = a.destroy!(); await deletingStarted;
    expect(await b.exec("while old delete is pending")).toContain("ok");
    finishDelete(); await deleting;
    expect(deleted).toEqual(["box-1"]);
    expect(boxes.has("box-2")).toBe(true);
    expect(await b.exec("after old delete")).toContain("ok");
  });
  it("validates configuration and the factory maps provider settings", async () => {
    installFetch(() => json({ box_id: "allocated" }));
    expect(() => new BoxRunSandbox({ baseUrl: "" })).toThrow("baseUrl required");
    await expect(sandboxFactory({ sessionId: "session-abcdefghijklmnopqrstuvwxyz12345" } as never, {})).rejects.toThrow("BOXRUN_URL");

    const instance = await sandboxFactory(
      { sessionId: "session-abcdefghijklmnopqrstuvwxyz12345" } as never,
      {
        BOXRUN_URL: "http://boxrun/v1/default/",
        SANDBOX_IMAGE: "custom:1",
        BOXRUN_CPUS: "4",
        BOXRUN_MEMORY_MIB: "1024",
        BOXRUN_TOKEN: "token",
      },
    );
    expect(instance).toBeInstanceOf(BoxRunSandbox);
    await expect(sandboxFactory({ sessionId: "short" } as never, { BOXRUN_URL: "http://boxrun" })).resolves.toBeInstanceOf(BoxRunSandbox);
  });

  it("factory prefers an Environment-selected catalog image over SANDBOX_IMAGE", async () => {
    installFetch(() => json({ box_id: "allocated" }));
    const env = { BOXRUN_URL: "http://boxrun", SANDBOX_IMAGE: "custom:1" };
    const selected = await sandboxFactory(
      { sessionId: "session", workdir: "/w", image: { alias: "analytics", reference: "registry.example/analytics:1" } },
      env,
    );
    expect((selected as unknown as { opts: { image?: string } }).opts.image).toBe("registry.example/analytics:1");
    const fallback = await sandboxFactory({ sessionId: "session", workdir: "/w" }, env);
    expect((fallback as unknown as { opts: { image?: string } }).opts.image).toBe("custom:1");
  });

  it("factory rejects a prepared sandbox base", async () => {
    await expect(sandboxFactory(
      { sessionId: "session", workdir: "/w", preparedBase: { provider: "boxrun", id: "base_1" } },
      { BOXRUN_URL: "http://boxrun" },
    )).rejects.toThrow("SANDBOX_PROVIDER=boxrun cannot create a sandbox from a prepared base");
  });

  it("creates once, forwards auth/env/resources, and decodes streamed output", async () => {
    const calls = installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (url.endsWith("/exec")) return json({ execution_id: "exec-1" });
      if (url.endsWith("/output")) {
        return sse(
          "event: stdout\ndata: {\"data\":\"aGVs\"}\n\n",
          "event: stdout\ndata: {\"data\":\"bG8=\"}\n\n"
          + "event: stderr\ndata: {\"data\":\"YmFk\"}\n\n"
          + "event: ignored\ndata: {}\n\n"
          + "event: exit\ndata: {\"exit_code\":3}\n\n",
        );
      }
      throw new Error(`unexpected ${url} ${String(init.method)}`);
    });
    const logs: string[] = [];
    const sandbox = new BoxRunSandbox({
      baseUrl: "http://boxrun/v1/default/",
      bearerToken: "secret",
      image: "image:1",
      cpus: 2,
      memoryMib: 512,
      sessionId: "abcdefghijklmnopqrstuvwxyz1234567890",
      defaultTimeoutSecs: 9,
      logger: { log: (message) => logs.push(message), warn: vi.fn() },
    });
    await sandbox.setEnvVars({ A: "1" });
    await sandbox.setEnvVars({ B: "2" });
    await expect(sandbox.exec("echo hi")).resolves.toBe("exit=3\nhello[stderr:bad]");
    await expect(sandbox.exec("echo again", 4)).resolves.toBe("exit=3\nhello[stderr:bad]");

    expect(logs).toEqual(["box created box-1 (image:1)"]);
    const create = calls.mock.calls.find(([url]) => String(url).endsWith("/boxes"));
    expect(JSON.parse(String(create?.[1]?.body))).toEqual({
      image: "image:1",
      name: "oma-abcdefghijklmnopqrstuvwxyz1234",
      cpus: 2,
      memory_mib: 512,
    });
    expect(new Headers(create?.[1]?.headers).get("authorization")).toBe("Bearer secret");
    const execs = calls.mock.calls.filter(([url]) => String(url).endsWith("/exec"));
    expect(JSON.parse(String(execs[0]?.[1]?.body))).toMatchObject({ env: { A: "1", B: "2" }, timeout_seconds: 9 });
    expect(JSON.parse(String(execs[1]?.[1]?.body))).toMatchObject({ timeout_seconds: 4 });
  });

  it("rejects malformed exit events instead of claiming command completion", async () => {
    installFetch((url) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (url.endsWith("/exec")) return json({ execution_id: "exec-1" });
      return sse(
        "event: stdout\n\n",
        ": keepalive\ndata: nope\n\n",
        "event: exit\ndata: {}\n\n",
        "event: stdout\ndata: {}\n\n",
        "event: stdout\ndata: {\"data\":\"eA==\"}\n\n",
      );
    });
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).exec("x")).rejects.toThrow("invalid exit event");
  });

  it.each(["eof", "read-error", "start-error"])("does not replay or acknowledge an effect when its response is lost (%s)", async mode => {
    const cause = new Error("socket closed");
    const failure = new Error("remote response lost", { cause });
    let effects = 0;
    const calls = installFetch((url) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (url.endsWith("/exec")) {
        effects++;
        if (mode === "start-error") throw failure;
        return json({ execution_id: "exec-1" });
      }
      if (mode === "eof") return sse('event: stdout\ndata: {"data":"Y2hhcmdlZA=="}\n\n');
      let sent = false;
      return new Response(new ReadableStream({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('event: stdout\ndata: {"data":"Y2hhcmdlZA=="}\n\n')); }
        else controller.error(failure);
      } }));
    });
    const result = new BoxRunSandbox({ baseUrl: "http://boxrun" }).exec("charge-account");
    if (mode === "eof") await expect(result).rejects.toThrow("stream ended before exit");
    else await expect(result).rejects.toBe(failure);
    expect(failure.cause).toBe(cause);
    expect(effects).toBe(1);
    expect(calls.mock.calls.filter(([url]) => String(url).endsWith("/exec"))).toHaveLength(1);
  });

  it("preserves an upload response loss after one remote file mutation", async () => {
    const failure = new Error("upload response lost");
    let writes = 0;
    installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (init.method === "PUT") { writes++; throw failure; }
      throw new Error("unexpected request");
    });
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).writeFile("/file", "data")).rejects.toBe(failure);
    expect(writes).toBe(1);
  });

  it("reports create, exec-start, and stream failures", async () => {
    installFetch(() => new Response("create-error", { status: 500 }));
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).exec("x")).rejects.toThrow("create failed: 500 create-error");

    installFetch((url) => url.endsWith("/boxes") ? json({ box_id: "box-1" }) : new Response("exec-error", { status: 409 }));
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).exec("x")).rejects.toThrow("exec start failed: 409 exec-error");

    installFetch((url) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (url.endsWith("/exec")) return json({ execution_id: "exec-1" });
      return new Response(null, { status: 200 });
    });
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).exec("x")).rejects.toThrow("exec stream failed: 200");
  });

  it("round-trips text and binary files through tar and covers path shapes", async () => {
    let uploaded: Uint8Array | undefined;
    const calls = installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (init.method === "PUT") {
        uploaded = init.body as Uint8Array;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/files?")) return new Response(uploaded, { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    const sandbox = new BoxRunSandbox({ baseUrl: "http://boxrun" });
    await expect(sandbox.writeFile("/workspace/a.txt", "hello")).resolves.toBe("/workspace/a.txt");
    await expect(sandbox.readFile("/workspace/a.txt")).resolves.toBe("hello");
    await expect(sandbox.readFileBytes("/workspace/a.txt")).resolves.toEqual(new TextEncoder().encode("hello"));
    await expect(sandbox.writeFileBytes("name", new Uint8Array())).resolves.toBe("name");
    expect(calls.mock.calls.some(([url]) => String(url).includes("path=%2F&overwrite=true"))).toBe(true);
  });

  it("reports file transport and invalid archive failures", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (init.method === "PUT") return new Response("no", { status: 500 });
      return new Response("no", { status: 404 });
    });
    const sandbox = new BoxRunSandbox({ baseUrl: "http://boxrun" });
    await expect(sandbox.writeFile("/a", "x")).rejects.toThrow("writeFile /a failed: 500 no");
    await expect(sandbox.readFile("/a")).rejects.toThrow("readFile /a failed: 404");
    await expect(sandbox.readFileBytes("/a")).rejects.toThrow("readFileBytes /a failed: 404");

    installFetch((url) => url.endsWith("/boxes") ? json({ box_id: "box-2" }) : new Response(new Uint8Array(512), { status: 200 }));
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).readFile("/a")).rejects.toThrow("no regular file");

    const nonRegular = new Uint8Array(1536);
    nonRegular[0] = 97;
    nonRegular[156] = 53;
    installFetch((url) => url.endsWith("/boxes") ? json({ box_id: "box-3" }) : new Response(nonRegular, { status: 200 }));
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).readFileBytes("/a")).rejects.toThrow("no regular file");
  });

  it("states unsupported mount semantics", async () => {
    const sandbox = new BoxRunSandbox({ baseUrl: "http://boxrun" });
    await expect(sandbox.mountMemoryStore({ storeName: "m", storeId: "1", readOnly: true })).rejects.toThrow("no mount primitive");
    await expect(sandbox.mountSessionOutputs({ tenantId: "t", sessionId: "s" })).rejects.toThrow("no host-bind primitive");
  });

  it("destroys idempotently but preserves uncertain create, HTTP, and transport failures", async () => {
    const warn = vi.fn();
    const logger = { log: vi.fn(), warn };
    const never = new BoxRunSandbox({ baseUrl: "http://boxrun", logger });
    await expect(never.destroy()).resolves.toBeUndefined();

    let deleteStatus = 404;
    installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (init.method === "PUT") return new Response(null, { status: 204 });
      if (init.method === "DELETE") return new Response(deleteStatus === 500 ? "bad" : null, { status: deleteStatus });
      throw new Error("unexpected");
    });
    const sandbox = new BoxRunSandbox({ baseUrl: "http://boxrun", logger });
    await sandbox.writeFile("/a", "x");
    await sandbox.destroy();
    expect(warn).not.toHaveBeenCalled();
    deleteStatus = 500;
    await sandbox.writeFile("/a", "x");
    await expect(sandbox.destroy()).rejects.toThrow("not confirmed");
    expect(warn).toHaveBeenCalledWith("boxrun destroy non-OK: 500 bad");

    installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-2" });
      if (init.method === "PUT") return new Response(null, { status: 204 });
      throw new Error("offline");
    });
    await sandbox.writeFile("/a", "x");
    await expect(sandbox.destroy()).rejects.toThrow("offline");
    expect(warn).toHaveBeenCalledWith("boxrun destroy error: offline");

    installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-default-logger" });
      if (init.method === "PUT") return new Response(null, { status: 204 });
      if (init.method === "DELETE") return new Response("bad", { status: 500 });
      throw new Error("unexpected");
    });
    const defaultLogger = new BoxRunSandbox({ baseUrl: "http://boxrun" });
    await defaultLogger.writeFile("/a", "x");
    await expect(defaultLogger.destroy()).rejects.toThrow("not confirmed");

    installFetch(() => new Response("bad", { status: 500 }));
    const failedCreate = new BoxRunSandbox({ baseUrl: "http://boxrun", logger });
    await expect(failedCreate.exec("x")).rejects.toThrow();
    await expect(failedCreate.destroy()).rejects.toThrow("allocation outcome is unknown");
  });

  it("retains the same physical box when deletion succeeded remotely but its response was lost", async () => {
    const failure = new Error("delete acknowledgement lost");
    let creates = 0;
    let deleted = false;
    const targets: string[] = [];
    installFetch((url, init) => {
      if (url.endsWith("/boxes")) { creates++; return json({ box_id: "captured-box" }); }
      if (init.method === "PUT") return new Response(null, { status: 204 });
      if (init.method === "DELETE") {
        targets.push(new URL(url).pathname);
        if (!deleted) { deleted = true; throw failure; }
        return new Response(null, { status: 404 });
      }
      throw new Error("unexpected request");
    });
    const sandbox = new BoxRunSandbox({ baseUrl: "http://boxrun" });
    await sandbox.writeFile("/file", "data");
    await expect(sandbox.destroy()).rejects.toBe(failure);
    await sandbox.destroy();
    expect(creates).toBe(1);
    expect(targets).toEqual(["/boxes/captured-box", "/boxes/captured-box"]);
  });
});
