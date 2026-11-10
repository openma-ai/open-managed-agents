import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { generateSandboxToken } from "@open-managed-agents/sandbox-gateway";
import { cfAcpExecutionChannelsResult } from "../../main/src/lib/cf-acp-execution-capability";

it("database lookup failure stays unavailable with no raw secret in the wire", async () => {
  const failure = new Error("password=private-db-secret");
  const result = await cfAcpExecutionChannelsResult({ ...env, PUBLIC_BASE_URL: "https://gateway.test", MAIN_DB: { prepare: () => { throw failure; } } } as never, { tenantId: "default", sessionId: "managed-missing", sessionsToken: generateSandboxToken() });
  expect(result).toMatchObject({ type: "failed", phase: "session_lookup", code: "unavailable", cause: { name: "AcpChannelsAuthorityUnavailable", code: "unavailable" } });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(JSON.stringify(result)).not.toContain("stack");
});

beforeAll(async () => { await exports.default.fetch(new Request("http://localhost/health")); });
it("actual channels RPC returns missing configuration as a safe value, not a callee rejection", async () => {
  const result = await env.MAIN_MCP!.managedAcpExecutionChannels!({ tenantId: "default", sessionId: "session-missing", sessionsToken: generateSandboxToken(), resultFormat: "typed" });
  expect(result).toMatchObject({ type: "failed", phase: "configuration", code: "missing_configuration" });
  expect(JSON.stringify(result)).not.toContain("private-never-in-error");
  expect(JSON.stringify(result)).not.toContain("stack");
});
it("actual channels RPC rejects malformed identity as a typed validation failure", async () => {
  expect(await env.MAIN_MCP!.managedAcpExecutionChannels!({ tenantId: "", sessionId: "", sessionsToken: "", resultFormat: "typed" })).toMatchObject({ type: "failed", phase: "validation", code: "invalid_request" });
});

// Work control credentials must not reach model/session lookup as a substitute.
it.each(["sk-ant-req-v1.work-private", "", "legacy-private"])("rejects non-sandbox control credential before touching storage", async sessionsToken => {
  let reads = 0;
  const result = await cfAcpExecutionChannelsResult({ ...env, PUBLIC_BASE_URL: "https://gateway.test", MAIN_DB: { prepare: () => { reads++; throw new Error("private-storage"); } } } as never, { tenantId: "default", sessionId: "sess", sessionsToken });
  expect(result).toMatchObject({ type: "failed", phase: "validation", code: "invalid_request" });
  expect(reads).toBe(0);
  expect(JSON.stringify(result)).not.toContain("private");
});

it.each(["not-a-url", "file:///workspace", "https://user:password@gateway.test", "https://gateway.test/path?private=1"])("refuses unusable execution gateway before storage: %s", async PUBLIC_BASE_URL => {
  const { generateSandboxToken } = await import("@open-managed-agents/sandbox-gateway");
  let reads = 0;
  const result = await cfAcpExecutionChannelsResult({ ...env, PUBLIC_BASE_URL, MAIN_DB: { prepare: () => { reads++; throw new Error("private-storage"); } } } as never, { tenantId: "default", sessionId: "sess", sessionsToken: generateSandboxToken() });
  expect(result).toMatchObject({ type: "failed", phase: "configuration", code: "missing_configuration" });
  expect(reads).toBe(0);
  expect(JSON.stringify(result)).not.toContain("private");
});
