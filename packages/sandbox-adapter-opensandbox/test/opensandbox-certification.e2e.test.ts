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
