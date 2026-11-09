import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RELAY_BUNDLE_SHA256 } from "../../sandbox-egress/src/relay-bundle.generated";
import { relayBundle } from "../../sandbox-egress/src/install";
// @ts-expect-error plain .mjs build script
import { bundleRelaySource, relaySha256 } from "../../sandbox-egress/scripts/build-relay-bundle.mjs";

describe("embedded sandbox relay bundle", () => {
  it("matches a fresh build of sandbox-egress/src/entry.ts", async () => {
    const fresh = await bundleRelaySource() as string;
    expect(relaySha256(fresh), "run: node packages/sandbox-egress/scripts/build-relay-bundle.mjs").toBe(RELAY_BUNDLE_SHA256);
    expect(relaySha256(await relayBundle())).toBe(RELAY_BUNDLE_SHA256);
  }, 60_000);

  it("refuses to start without a delivered binding (never a relay with no token)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oma-relay-"));
    const entry = join(directory, "relay.cjs");
    writeFileSync(entry, await relayBundle());
    try {
      const code = await new Promise<number | null>((resolve) => spawn(process.execPath, [entry, directory], { stdio: "ignore" }).once("exit", resolve));
      expect(code).toBe(1);
      expect(existsSync(join(directory, "ready.json"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("starts as a plain node process, takes its binding into memory (the file is deleted, the token is in no file) and serves /health", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oma-relay-"));
    const entry = join(directory, "relay.cjs");
    writeFileSync(entry, await relayBundle());
    const token = "oma_sbx_relay-bundle-test-token";
    writeFileSync(join(directory, "binding.json"), JSON.stringify({ endpoint: "https://gateway.invalid", sessionId: "sess", token, deliveryId: "delivery-1" }), { mode: 0o600 });
    const child = spawn(process.execPath, [entry, directory], { stdio: "ignore" });
    try {
      let ready: { pid: number; port: number; caFile: string; protocol: number; bindingId: string } | null = null;
      for (let i = 0; i < 100 && ready === null; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (existsSync(join(directory, "ready.json"))) ready = JSON.parse(readFileSync(join(directory, "ready.json"), "utf8"));
      }
      expect(ready?.pid).toBe(child.pid);
      expect(ready).toMatchObject({ protocol: 3, bindingId: "delivery-1" });
      expect(existsSync(join(directory, "binding.json"))).toBe(false);
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isFile()) expect(readFileSync(path, "latin1").includes(token), name).toBe(false);
      }
      expect(readFileSync(ready!.caFile, "utf8")).toContain("BEGIN CERTIFICATE");
      const status = await new Promise<number>((resolve, reject) => {
        request({ host: "127.0.0.1", port: ready!.port, path: "/health" }, (response) => { response.resume(); resolve(response.statusCode ?? 0); })
          .on("error", reject).end();
      });
      expect(status).toBe(200);
    } finally {
      child.kill("SIGTERM");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
