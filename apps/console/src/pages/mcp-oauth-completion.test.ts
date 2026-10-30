import { expect, it, vi } from "vitest";
import { buildMcpOAuthRoutes } from "../../../../packages/managed-agents-api/src/routes/mcp-oauth";

it("leaves archival failure visible with the affected credential IDs instead of silently closing", async () => {
  const routes = buildMcpOAuthRoutes({
    authorize: async () => ({ type: "not_found" }),
    complete: async () => ({ type: "archive_failed", vaultId: "vlt_1", credentialId: "cred_new", unarchivedCredentialIds: ["cred_old"] }),
  }, { consoleOrigins: [] });
  const response = await routes.request("https://api.example.test/callback?code=c&state=s");
  expect(response.status).toBe(500);
  const page = await response.text();
  expect(page).toContain("cred_old");
  expect(page).toContain("vlt_1");
  const popup = { close: vi.fn() };
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  new Function("window", script)(popup);
  expect(popup.close).not.toHaveBeenCalled();
});

it("falls back to the configured Console when COOP severs opener on another origin", async () => {
  const routes = buildMcpOAuthRoutes({
    authorize: async () => ({ type: "not_found" }),
    complete: async () => ({ type: "connected", vaultId: "vlt_1", credentialId: "cred_1", serviceName: "Example", returnTo: "https://console.example.test/vaults/vlt_1", probeOk: true }),
  }, { consoleOrigins: ["https://console.example.test"] });
  const response = await routes.request("https://api.example.test/callback?code=c&state=s");
  expect(response.status).toBe(200);
  const page = await response.text();
  const script = page.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const popup = { opener: null, location: { origin: "https://api.example.test", href: "https://api.example.test/callback" }, close: vi.fn() };
  class Channel { postMessage() {} close() {} }
  new Function("window", "BroadcastChannel", script)(popup, Channel);
  expect(popup.close).not.toHaveBeenCalled();
  expect(popup.location.href).toBe("https://console.example.test/vaults/vlt_1?oauth=success&service=Example&probe_ok=1");
});
