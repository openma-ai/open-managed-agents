import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { SandboxManager } from "@alibaba-group/opensandbox";
import { sandboxProvider, type OpenSandbox } from "../src/index";

it.skipIf(process.env.OMA_OPENSANDBOX_CERTIFICATION !== "1")("runs the SDK-backed adapter against a real OpenSandbox server", async () => {
  const ctx = { sessionId: `sdk-certification-${randomUUID()}`, workdir: "/workspace" };
  const marker = `OPENMA_OFFICIAL_SDK_${randomUUID()}`;
  const binary = Uint8Array.of(0, 255, 1, 0, 10, 13, 194, 169);
  let original: OpenSandbox | undefined;
  let attached: OpenSandbox | undefined;
  try {
    original = await sandboxProvider.create(ctx, process.env);
    expect(await original.status()).toBe("running");
    expect(await original.exec(`printf '%s' '${marker}'`)).toBe(marker);
    expect(await original.exec("printf out; printf err >&2; exit 7")).toBe("out\nerr\n[exit 7]");
    await original.writeFile("/workspace/sdk-check.txt", marker);
    expect(await original.readFile("/workspace/sdk-check.txt")).toBe(marker);
    await original.writeFileBytes("/workspace/sdk-check.bin", binary);
    expect(await original.readFileBytes("/workspace/sdk-check.bin")).toEqual(binary);
    await original.renewLease({ ttlMs: 180_000 });
    attached = await sandboxProvider.resume(original.runtimeHandle(), ctx, process.env);
    expect(await attached.readFileBytes("/workspace/sdk-check.bin")).toEqual(binary);

    const child = await attached.spawnDuplexProcess({
      command: "node", args: ["-e", "process.stdin.on('data', b => {process.stdout.write(b); process.stderr.write(b)}); process.stdin.on('end', () => process.exitCode = 7)"],
    });
    const stdout = new Response(child.stdout).arrayBuffer();
    const stderr = new Response(child.stderr).arrayBuffer();
    const writer = child.stdin.getWriter();
    await writer.write(binary);
    await writer.close();
    expect(new Uint8Array(await stdout)).toEqual(binary);
    expect(new Uint8Array(await stderr)).toEqual(binary);
    expect(await child.exited).toEqual({ code: 7, signal: null });

    const id = original.id;
    await attached.destroy();
    await original.destroy();
    expect(await original.status()).toBe("stopped");
    const manager = SandboxManager.create({ connectionConfig: {
      domain: process.env.OPENSANDBOX_DOMAIN,
      protocol: process.env.OPENSANDBOX_PROTOCOL === "https" ? "https" : "http",
      apiKey: process.env.OPENSANDBOX_API_KEY ?? process.env.OPEN_SANDBOX_API_KEY,
      disableMetrics: true,
    } });
    try {
      try { expect(["terminated", "deleted"]).toContain((await manager.getSandboxInfo(id)).status.state.toLowerCase()); }
      catch (error) { expect(error).toMatchObject({ statusCode: 404 }); }
    }
    finally { await manager.close(); }
  } finally {
    try { await attached?.destroy(); }
    finally { await original?.destroy(); }
  }
}, 240_000);

function certificationManager() {
  return SandboxManager.create({ connectionConfig: {
    domain: process.env.OPENSANDBOX_DOMAIN,
    protocol: process.env.OPENSANDBOX_PROTOCOL === "https" ? "https" : "http",
    apiKey: process.env.OPENSANDBOX_API_KEY ?? process.env.OPEN_SANDBOX_API_KEY,
    disableMetrics: true,
  } });
}

it.skipIf(process.env.OMA_OPENSANDBOX_CERTIFICATION !== "1")("pauses, resumes, snapshots and restores against a real OpenSandbox server", async () => {
  const ctx = { sessionId: `sdk-certification-${randomUUID()}`, workdir: "/workspace" };
  const marker = `OPENMA_PAUSE_${randomUUID()}`;
  const binary = Uint8Array.of(0, 255, 1, 0, 10, 13, 194, 169);
  const manager = certificationManager();
  const owned: OpenSandbox[] = [];
  const snapshots: string[] = [];
  try {
    const original = await sandboxProvider.create(ctx, process.env);
    owned.push(original);
    await original.writeFile("/workspace/state.txt", marker);
    await original.writeFileBytes("/workspace/state.bin", binary);
    // A process plus in-memory state proves pause retains the same resource.
    await original.exec("nohup sh -c 'n=0; while true; do n=$((n+1)); echo $n > /workspace/counter; sleep 0.2; done' >/dev/null 2>&1 & echo $! > /workspace/loop.pid");
    const pid = (await original.readFile("/workspace/loop.pid")).trim();

    // In-place pause/resume on the same adapter object.
    const paused = await original.suspend({ kind: "memory" });
    expect(paused).toMatchObject({ provider: "opensandbox", scope: "runtime", checkpointId: original.id });
    expect(await original.status()).toBe("suspended");
    const frozen = (await manager.getSandboxInfo(original.id)).status.state;
    expect(frozen).toBe("Paused");
    await original.resume(paused);
    expect(await original.status()).toBe("running");
    expect(await original.readFile("/workspace/state.txt")).toBe(marker);
    expect(await original.readFileBytes("/workspace/state.bin")).toEqual(binary);
    expect(await original.exec(`kill -0 ${pid} && echo alive`)).toBe("alive");
    const before = Number(await original.readFile("/workspace/counter"));
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect(Number(await original.readFile("/workspace/counter"))).toBeGreaterThan(before);

    // Retained-runtime path: pause, then attach by persisted handle.
    await original.suspend({ kind: "filesystem" });
    const attached = await sandboxProvider.resume(original.runtimeHandle(), ctx, process.env);
    owned.push(attached);
    expect(await attached.status()).toBe("running");
    expect(await attached.readFile("/workspace/state.txt")).toBe(marker);
    expect(await attached.exec(`kill -0 ${pid} && echo alive`)).toBe("alive");

    // Portable filesystem snapshot and restore into a new runtime.
    await attached.writeFile("/workspace/snapshot.txt", `${marker}-snapshot`);
    const checkpoint = await attached.checkpoint({ kind: "filesystem", name: `oma-cert-${randomUUID().slice(0, 8)}` });
    snapshots.push(checkpoint.checkpointId);
    expect(checkpoint).toMatchObject({ provider: "opensandbox", scope: "portable", kind: "filesystem", sourceRuntimeId: original.id });
    expect((await manager.getSnapshot(checkpoint.checkpointId)).status.state).toBe("Ready");
    await attached.writeFile("/workspace/snapshot.txt", "changed-after-snapshot");
    const restored = await sandboxProvider.restore(checkpoint, ctx, process.env);
    owned.push(restored);
    expect(restored.id).not.toBe(original.id);
    expect(await restored.status()).toBe("running");
    expect(await restored.readFile("/workspace/snapshot.txt")).toBe(`${marker}-snapshot`);
    expect(await restored.readFile("/workspace/state.txt")).toBe(marker);
    expect(await restored.readFileBytes("/workspace/state.bin")).toEqual(binary);
    expect(await restored.exec("printf restored-ok")).toBe("restored-ok");
    // Filesystem snapshot only: the loop process does not survive restore
    // (PIDs may be reused in the new container, so observe the counter).
    const frozenCounter = await restored.readFile("/workspace/counter");
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect(await restored.readFile("/workspace/counter")).toBe(frozenCounter);
  } finally {
    for (const sandbox of owned.reverse()) await sandbox.destroy().catch(() => undefined);
    for (const id of snapshots) await manager.deleteSnapshot(id).catch(() => undefined);
    await manager.close();
  }
}, 600_000);
