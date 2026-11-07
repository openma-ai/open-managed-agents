import { describe, expect, it, vi } from "vitest";
import {
  buildCfManagedSandboxExecRoutes,
  type CfManagedSandboxExecSession,
} from "../src/lib/cf-managed-sandbox-exec";

function harness(options: {
  session?: CfManagedSandboxExecSession | null;
  environmentType?: "cloud" | "self_hosted" | null;
  runtime?: (request: Request) => Promise<Response>;
} = {}) {
  const requests: Request[] = [];
  const runtime = options.runtime ?? (async () => Response.json({ exit_code: 0, output: "ok\n", truncated: false }));
  const app = buildCfManagedSandboxExecRoutes({
    workspaceId: () => "ws_1",
    retrieveSession: async () => options.session === undefined
      ? { status: "idle", archivedAt: null, environmentId: "env_1" }
      : options.session,
    environmentType: async () => options.environmentType === undefined ? "cloud" : options.environmentType,
    fetcher: () => ({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return runtime(request);
      },
    }),
  });
  const call = (body: unknown) => app.request("/sess_1/sandbox/exec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { call, requests };
}

describe("Cloudflare POST /v1/oma/sessions/:id/sandbox/exec", () => {
  it("runs the command in the session's SessionDO sandbox with the workspace scope", async () => {
    const { call, requests } = harness({
      runtime: async () => Response.json({ exit_code: 3, output: "boom\n", truncated: false }),
    });
    const response = await call({ command: "echo 'hi' && exit 3", timeout_ms: 120_000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ exit_code: 3, output: "boom" });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/sessions/sess_1/exec");
    expect(request.headers.get("x-oma-workspace-id")).toBe("ws_1");
    expect(await request.json()).toEqual({
      command: `sh -c 'echo '\\''hi'\\'' && exit 3' 2>&1`,
      timeout_ms: 120_000,
    });
  });

  it("defaults timeout_ms to 60s", async () => {
    const { call, requests } = harness();
    await call({ command: "true" });
    expect((await requests[0]!.json() as { timeout_ms: number }).timeout_ms).toBe(60_000);
  });

  it.each([
    ["not json"],
    [{}],
    [{ command: "" }],
    [{ command: "x", timeout_ms: 0 }],
    [{ command: "x", timeout_ms: 1.5 }],
    [{ command: "x", timeout_ms: 3_600_001 }],
  ])("rejects body %j with 400", async (body) => {
    const { call, requests } = harness();
    expect((await call(body)).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("404s a missing or archived session", async () => {
    expect((await harness({ session: null }).call({ command: "x" })).status).toBe(404);
    expect((await harness({
      session: { status: "idle", archivedAt: "2026-01-01T00:00:00Z", environmentId: "env_1" },
    }).call({ command: "x" })).status).toBe(404);
  });

  it.each(["running", "rescheduling"])("409s while the session is %s", async (status) => {
    const { call, requests } = harness({ session: { status, archivedAt: null, environmentId: "env_1" } });
    const response = await call({ command: "x" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: `Session is ${status}; exec requires a session that is not running` });
    expect(requests).toHaveLength(0);
  });

  it("409s a self-hosted session, which has no Cloudflare sandbox", async () => {
    const response = await harness({ environmentType: "self_hosted" }).call({ command: "x" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Session has no connected sandbox" });
  });

  it("502s sandbox failures", async () => {
    const failed = harness({
      runtime: async () => Response.json({ exit_code: -1, output: "sandbox exec error: gone", error: true }, { status: 500 }),
    });
    const response = await failed.call({ command: "x" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "sandbox exec error: gone" });

    const unparsed = harness({ runtime: async () => Response.json({ exit_code: -1, output: "exit=undefined" }) });
    expect((await unparsed.call({ command: "x" })).status).toBe(502);

    const thrown = harness({ runtime: vi.fn(async () => { throw new Error("binding down"); }) });
    expect(await (await thrown.call({ command: "x" })).json()).toEqual({ error: "binding down" });
  });
});
