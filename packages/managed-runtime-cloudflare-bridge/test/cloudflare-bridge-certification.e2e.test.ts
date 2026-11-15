import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import { expect, it } from "vitest";
import { createCloudflareBridgeProvider, type CloudflareBridgeRuntime } from "../src/index";

// Opt-in: runs against an operator-deployed official Cloudflare Sandbox Bridge.
// BRIDGE_URL / BRIDGE_API_KEY must point at a disposable deployment.
const enabled = process.env.OMA_CLOUDFLARE_BRIDGE_CERTIFICATION === "1"
  && Boolean(process.env.BRIDGE_URL) && Boolean(process.env.BRIDGE_API_KEY);

it.skipIf(!enabled)("runs the adapter against a real Cloudflare Sandbox Bridge", async () => {
  const provider = createCloudflareBridgeProvider({
    baseUrl: process.env.BRIDGE_URL!, apiKey: process.env.BRIDGE_API_KEY!, checkpointStore: new InMemoryBlobStore(),
  });
  const binary = Uint8Array.of(0, 255, 1, 0, 10, 13, 194, 169);
  const created: CloudflareBridgeRuntime[] = [];
  try {
    const runtime = await provider.create({ sessionId: "certification", workdir: "/workspace" }, {});
    created.push(runtime);
    expect(await runtime.status()).toBe("running");
    expect(await runtime.exec("printf '%s' certified", 120_000)).toBe("certified");
    await runtime.writeFileBytes("/workspace/cert dir/a b.bin", binary);
    expect(await runtime.readFileBytes("/workspace/cert dir/a b.bin")).toEqual(binary);
    await runtime.writeFile("/workspace/cert.txt", "héllo");
    expect(await runtime.readFile("/workspace/cert.txt")).toBe("héllo");

    // The official Bridge exposes the stable `/exec` transport. Interactive
    // `/process` + stdin is not part of that API; the provider advertises
    // `ama_worker` only, so duplex-process coverage stays in the mocked
    // contract tests instead of pretending the live service supports ACP.
    const checkpoint = await runtime.checkpoint({ kind: "filesystem", name: "certification" });
    await runtime.destroy();
    // Containers are capacity-limited per account; restore after the original is gone.
    const restored = await provider.restore(checkpoint, { sessionId: "certification-restore", workdir: "/workspace" }, {});
    created.push(restored);
    expect(await restored.readFile("/workspace/cert.txt")).toBe("héllo");
    await restored.destroy();
  } finally {
    await Promise.allSettled(created.map((runtime) => runtime.destroy()));
  }
}, 600_000);
