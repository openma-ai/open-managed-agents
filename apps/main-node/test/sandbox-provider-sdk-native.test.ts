import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = fileURLToPath(new URL("../", import.meta.url));
const requireFromApp = createRequire(new URL("../package.json", import.meta.url));

// Native Node owns resolution here, not Vitest/Vite. The adapter is a real
// workspace symlink; the real SDK is installed only in the injecting app.
async function probe(provider: "e2b" | "opensandbox", withSdk: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "oma-sdk-native-"));
  try {
    const src = join(dir, "apps/main-node/src");
    const modules = join(dir, "apps/main-node/node_modules");
    await mkdir(src, { recursive: true });
    await mkdir(join(modules, "@open-managed-agents"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await copyFile(join(app, "src/sandbox-provider-sdk.ts"), join(src, "sandbox-provider-sdk.ts"));
    const adapter = "@open-managed-agents/sandbox-adapter-" + provider;
    const entry = requireFromApp.resolve(adapter);
    await symlink(dirname(dirname(entry)), join(modules, adapter));
    if (provider === "e2b") {
      const manifest = JSON.parse(await readFile(join(dirname(dirname(entry)), "package.json"), "utf8")) as {
        dependencies?: Record<string, unknown>;
        peerDependencies?: Record<string, unknown>;
      };
      if (manifest.dependencies?.e2b !== undefined) {
        throw new Error("adapter must not own E2B as a production dependency");
      }
      if (manifest.peerDependencies?.e2b === undefined) {
        throw new Error("adapter must declare E2B as an optional peer");
      }
    }
    if (withSdk) {
      const sdk = requireFromApp.resolve("e2b/package.json");
      await symlink(dirname(sdk), join(modules, "e2b"));
    }
    const code = `
      import { createRequire } from "node:module";
      import { assertSandboxProviderSdk } from "./apps/main-node/src/sandbox-provider-sdk.ts";
      const app = createRequire(new URL("./apps/main-node/src/probe.ts", import.meta.url));
      const adapter = ${JSON.stringify(adapter)};
      if (${withSdk}) {
        console.log("app SDK", app.resolve("e2b"));
      }
      assertSandboxProviderSdk({ provider: ${JSON.stringify(provider)}, modulePath: adapter });
      if (${withSdk}) {
        const sdk = await import(app.resolve("e2b"));
        const { createE2BSandboxFactory } = await import(app.resolve(adapter));
        console.log("factory", typeof createE2BSandboxFactory(sdk));
      } else console.log("checked", ${JSON.stringify(provider)});
    `;
    return spawnSync(process.execPath, ["--import", requireFromApp.resolve("tsx"), "--input-type=module", "-e", code], {
      cwd: dir, encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_PATH: "" },
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("native SDK resolution in an isolated pnpm layout", () => {
  it("accepts main-node's injected E2B SDK without an adapter peer install", async () => {
    const result = await probe("e2b", true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("factory function");
  });

  it("fails fast with installation guidance when the injecting app lacks E2B", async () => {
    const result = await probe("e2b", false);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/SANDBOX_PROVIDER=e2b requires the "e2b" SDK/);
    expect(result.stderr).toContain("SANDBOX_PROVIDERS=e2b");
  });

  it("still resolves non-injected provider SDKs from their adapter", async () => {
    const result = await probe("opensandbox", false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("checked opensandbox");
  });
});
