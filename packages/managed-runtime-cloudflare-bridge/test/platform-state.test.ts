import { expect, it } from "vitest";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import { CloudflareBridgeRuntime } from "../src/cloudflare-bridge";

function fixture(status = 200, responseBytes = Uint8Array.of(0, 255, 65)) {
  const calls: Request[] = [];
  const runtime = new CloudflareBridgeRuntime({ baseUrl: "https://bridge.test", apiKey: "host-only", runtimeId: "box/1", checkpointStore: new InMemoryBlobStore(),
    fetch: async (url, init) => { const req = new Request(url, init); calls.push(req); return new Response(responseBytes, { status }); } });
  return { runtime, calls };
}

it.each(["session-binding.json", "acp-session.json"])("uses narrow authenticated raw-byte transport for ACP %s", async file => {
  const f = fixture(); const path = "/oma/harness-state/acp/session_A-1/claude-acp/v1/" + file;
  const bytes = Uint8Array.of(0, 255, 65);
  expect(await f.runtime.writeFileBytes(path, bytes)).toBe(path);
  expect(await f.runtime.readFileBytes(path)).toEqual(bytes);
  expect(f.calls.map(req => ({ url: req.url, method: req.method, auth: req.headers.get("authorization") }))).toEqual([
    { url: "https://bridge.test/v1/sandbox/box%2F1/platform-state/file?path=" + encodeURIComponent(path), method: "PUT", auth: "Bearer host-only" },
    { url: "https://bridge.test/v1/sandbox/box%2F1/platform-state/file?path=" + encodeURIComponent(path), method: "GET", auth: "Bearer host-only" },
  ]);
  expect(new Uint8Array(await f.calls[0].arrayBuffer())).toEqual(bytes);
});

it("propagates a missing platform checkpoint without trying exec or workspace fallback", async () => {
  const f = fixture(404);
  await expect(f.runtime.readFile("/oma/harness-state/acp/s/claude-acp/v1/acp-session.json")).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].method).toBe("GET");
});

it.each([
  "/oma/secret", "/oma/harness-state/acp/s/claude-acp/v1/native/key",
  "/oma/harness-state/acp/s/claude-acp/v1/../acp-session.json",
  "/oma/harness-state/acp/s/Claude/v1/acp-session.json",
  "/oma/harness-state/acp/s%2Fother/claude-acp/v1/acp-session.json",
  "/oma//harness-state/acp/s/claude-acp/v1/acp-session.json",
])("does not broaden platform-state access: %s", async path => {
  const f = fixture();
  await expect(f.runtime.readFileBytes(path)).rejects.toThrow();
  await expect(f.runtime.writeFileBytes(path, Uint8Array.of(1))).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

it("rejects oversized platform state before dispatch", async () => {
  const f = fixture();
  await expect(f.runtime.writeFileBytes("/oma/harness-state/acp/s/claude-acp/v1/acp-session.json", new Uint8Array(1024 * 1024 + 1))).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
