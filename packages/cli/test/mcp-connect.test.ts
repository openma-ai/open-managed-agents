import { describe, expect, it } from "vitest";
import { connectMcpOAuth } from "../src/mcp-connect";

describe("CLI MCP connect", () => {
  it("POSTs authorization secrets, opens only the provider URL and claims with an independent credential", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const opened: string[] = [];
    const output: string[] = [];
    const result = await connectMcpOAuth({
      request: async <T>(path: string, init?: RequestInit) => {
        calls.push({ path, init });
        return (path.endsWith("authorize") ? { authorization_url: "https://provider.example.test/authorize?state=sealed", flow_id: "flow_1", claim_token: "claim-secret", expires_at: new Date(Date.now() + 60000).toISOString(), interval_seconds: 2 } : { status: "ready", credential_id: "cred_1" }) as T;
      },
      openBrowser: (url) => { opened.push(url); }, print: (text) => output.push(text), sleep: async () => {},
    }, { vaultId: "vlt_1", serverUrl: "https://mcp.example.test/mcp", clientId: "client", clientSecret: "private-secret" });
    expect(result).toBe("cred_1");
    expect(calls).toEqual([
      { path: "/v1/oma/oauth/cli/authorize", init: { method: "POST", body: JSON.stringify({ vault_id: "vlt_1", mcp_server_url: "https://mcp.example.test/mcp", client_id: "client", client_secret: "private-secret" }) } },
      { path: "/v1/oma/oauth/cli/result", init: { method: "POST", body: JSON.stringify({ flow_id: "flow_1", claim_token: "claim-secret" }) } },
    ]);
    expect(opened).toEqual(["https://provider.example.test/authorize?state=sealed"]);
    expect(output.join("\n")).not.toContain("private-secret");
    expect(output.join("\n")).not.toContain("claim-secret");
  });

  it("waits through pending but rejects failed or expired flows without claiming success", async () => {
    for (const terminal of ["failed", "expired"]) {
      let polls = 0;
      await expect(connectMcpOAuth({ request: async <T>(path: string) => (path.endsWith("authorize") ? { authorization_url: "https://provider.example.test/authorize", flow_id: "f", claim_token: "s", expires_at: new Date(Date.now() + (terminal === "expired" ? -1 : 60000)).toISOString(), interval_seconds: 1 } : { status: ++polls === 1 ? "pending" : "failed" }) as T, openBrowser: () => {}, print: () => {}, sleep: async () => {} }, { vaultId: "v", serverUrl: "https://mcp.example.test" })).rejects.toThrow(terminal === "expired" ? /timed out/i : /failed/i);
    }
  });
});
