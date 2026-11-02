import { createHash, randomBytes } from "node:crypto";
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
  const secret = randomBytes(16).toString("hex");
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

    // Env reaches the child, but no process command line in the container holds the value.
    const child = await runtime.spawnDuplexProcess({
      command: "sh", cwd: "/workspace", env: { OMA_CERT_SECRET: secret, OMA_PLAIN: "plain" },
      args: ["-c", [
        'echo "sha=$(printf %s "$OMA_CERT_SECRET" | sha256sum | cut -c1-64)"',
        'echo "plain=$OMA_PLAIN"',
        'c=0; for f in /proc/[0-9]*/cmdline; do tr "\\000" " " < "$f" 2>/dev/null | grep -qF "$OMA_CERT_SECRET" && c=$((c+1)); done; echo "cmdline_hits=$c"',
        "exit 3",
      ].join("; ")],
    });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toEqual({ code: 3, signal: null });
    expect(stdout).toContain(`sha=${createHash("sha256").update(secret).digest("hex")}`);
    expect(stdout).toContain("plain=plain");
    expect(stdout).toContain("cmdline_hits=0");
    expect(stdout).not.toContain(secret);

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
