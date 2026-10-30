import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  CapCliDeviceFlowApplicationService,
  CredentialsApplicationService,
  type CapCliDeviceFlowPollResult,
  type CapCliDeviceFlowPort,
  type CapCliFlowTokenCipher,
} from "@open-managed-agents/managed-agents-application";
import { MemoryCredentialStore } from "../../credential-store-memory/src/index";
import { WebCryptoAesGcm } from "../../integrations-adapters-cf/src/crypto";
import { buildCapCliDeviceFlowRoutes } from "../src/index";

const WORKSPACE = "ws_1";
const NOW = Date.parse("2026-09-01T00:00:00.000Z");

// Not real encryption: the routes only rely on the cipher round-tripping
// and rejecting foreign ciphertexts.
const cipher: CapCliFlowTokenCipher = {
  encrypt: async (plaintext) => `sealed:${btoa(plaintext)}`,
  decrypt: async (ciphertext) => {
    if (!ciphertext.startsWith("sealed:")) throw new Error("bad ciphertext");
    return atob(ciphertext.slice("sealed:".length));
  },
};

function harness(
  pollResults: CapCliDeviceFlowPollResult[],
  options: { cipher?: CapCliFlowTokenCipher; nowMs?: () => number } = {},
) {
  const store = new MemoryCredentialStore();
  let ids = 0;
  const credentials = new CredentialsApplicationService({
    workspaceId: WORKSPACE,
    store,
    vaults: {
      find: async ({ vaultId }) =>
        vaultId === "vlt_1"
          ? { id: vaultId, archivedAt: null, createdAt: "", displayName: "v", metadata: {}, updatedAt: "" }
          : null,
    },
    validation: { validate: async () => { throw new Error("unused"); } },
    cliCatalog: { has: (cliId) => cliId === "gh" || cliId === "fly" },
    clock: { now: () => new Date(NOW + ids * 1000) },
    ids: { nextCredentialId: () => `vcrd_${++ids}` },
  });
  const polled: unknown[] = [];
  const deviceFlow: CapCliDeviceFlowPort = {
    initiate: async (cliId) => {
      if (cliId === "fly") return { type: "no_device_flow" };
      if (cliId !== "gh") return { type: "unknown_cli" };
      return {
        type: "started",
        state: {
          deviceCode: "device-code-secret",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          intervalSeconds: 5,
          expiresAtMs: NOW + 900_000,
        },
      };
    },
    poll: async (cliId, state) => {
      polled.push({ cliId, state });
      return pollResults.shift() ?? { type: "pending" };
    },
  };
  let workspace = WORKSPACE;
  const app = new Hono();
  app.route("/v1/oma/vaults", buildCapCliDeviceFlowRoutes(() =>
    new CapCliDeviceFlowApplicationService({
      workspaceId: workspace,
      credentials,
      deviceFlow,
      cipher: options.cipher ?? cipher,
      clock: { now: () => new Date((options.nowMs ?? (() => NOW))()) },
    })));
  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return {
    credentials,
    store,
    polled,
    post,
    switchWorkspace: (next: string) => { workspace = next; },
  };
}

describe("cap_cli device flow routes (OpenMA extension)", () => {
  it("starts a flow without exposing the device code", async () => {
    const h = harness([]);
    const started = await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow", { cli_id: "gh" });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      type: "cap_cli_device_flow",
      cli_id: "gh",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      interval_seconds: 5,
      expires_at: new Date(NOW + 900_000).toISOString(),
    });
    expect(JSON.stringify({ ...started.body, flow_token: undefined })).not.toContain("device-code-secret");
  });

  it("rejects unknown vaults, unknown CLIs, and CLIs without a device flow", async () => {
    const h = harness([]);
    expect((await h.post("/v1/oma/vaults/vlt_missing/cap_cli_device_flow", { cli_id: "gh" })).status).toBe(404);
    expect((await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow", { cli_id: "nope" })).status).toBe(400);
    expect((await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow", { cli_id: "fly" })).status).toBe(400);
    expect((await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow", {})).status).toBe(400);
  });

  it("writes a managed cap_cli credential when ready and archives the previous one", async () => {
    const h = harness([
      { type: "pending" },
      { type: "slow_down", intervalSeconds: 10 },
      {
        type: "ready",
        token: { token: "gho_new", refreshToken: "ghr_new", expiresAt: null, extras: { token_type: "bearer" } },
      },
    ]);
    const previous = await h.credentials.createCredential({
      vaultId: "vlt_1",
      auth: { type: "cap_cli", cliId: "gh", token: "gho_old" },
    });
    expect(previous.type).toBe("created");
    const started = await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow", { cli_id: "gh" });
    let flowToken = started.body.flow_token as string;

    expect((await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow/poll", { flow_token: flowToken })).body)
      .toEqual({ status: "pending" });
    const slowed = await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow/poll", { flow_token: flowToken });
    expect(slowed.body).toMatchObject({ status: "slow_down", interval_seconds: 10 });
    flowToken = slowed.body.flow_token;
    const ready = await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow/poll", { flow_token: flowToken });
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ready", credential_id: "vcrd_2" });
    expect((h.polled[2] as { state: { intervalSeconds: number } }).state.intervalSeconds).toBe(10);

    const stored = await h.store.list({ workspaceId: WORKSPACE, vaultId: "vlt_1", includeArchived: true, limit: 10 });
    const byId = Object.fromEntries(stored.map((record) => [record.credential.id, record.credential]));
    expect(byId.vcrd_1?.archivedAt).not.toBeNull();
    expect(byId.vcrd_2).toMatchObject({
      archivedAt: null,
      displayName: "gh (OAuth)",
      auth: { type: "cap_cli", cliId: "gh", token: "gho_new", refreshToken: "ghr_new", extras: { token_type: "bearer" } },
    });
  });

  it("refuses a flow token bound to another workspace or vault, or forged", async () => {
    const h = harness([]);
    const started = await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow", { cli_id: "gh" });
    const flowToken = started.body.flow_token as string;
    expect((await h.post("/v1/oma/vaults/vlt_2/cap_cli_device_flow/poll", { flow_token: flowToken })).status).toBe(404);
    h.switchWorkspace("ws_other");
    expect((await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow/poll", { flow_token: flowToken })).status).toBe(404);
    expect((await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow/poll", { flow_token: "forged" })).status).toBe(400);
    expect(h.polled).toEqual([]);
  });

  describe("with the production AES-GCM cipher", () => {
    const realCipher = new WebCryptoAesGcm("test-root-secret", "managed.vault.cap_cli_device_flow");

    it("round-trips a flow token and keeps the device code out of it", async () => {
      const h = harness([{ type: "pending" }], { cipher: realCipher });
      const started = await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow", { cli_id: "gh" });
      expect(started.body.flow_token).not.toContain("device-code-secret");
      const polled = await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow/poll", {
        flow_token: started.body.flow_token,
      });
      expect(polled.body).toEqual({ status: "pending" });
      expect(h.polled).toHaveLength(1);
    });

    it("rejects a tampered flow token", async () => {
      const h = harness([], { cipher: realCipher });
      const started = await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow", { cli_id: "gh" });
      const token = started.body.flow_token as string;
      const index = Math.floor(token.length / 2);
      const flipped = token[index] === "A" ? "B" : "A";
      const tampered = token.slice(0, index) + flipped + token.slice(index + 1);
      const polled = await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow/poll", { flow_token: tampered });
      expect(polled.status).toBe(400);
      expect(h.polled).toEqual([]);
    });

    it("rejects a token sealed under another purpose key", async () => {
      const other = new WebCryptoAesGcm("test-root-secret", "managed.vault.credentials");
      const sealed = await other.encrypt(JSON.stringify({ v: 1 }));
      const h = harness([], { cipher: realCipher });
      expect((await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow/poll", { flow_token: sealed })).status).toBe(400);
    });

    it("reports an expired flow without polling the provider", async () => {
      let now = NOW;
      const h = harness([], { cipher: realCipher, nowMs: () => now });
      const started = await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow", { cli_id: "gh" });
      now = NOW + 900_000;
      const polled = await h.post("/v1/oma/vaults/vlt_1/cap_cli_device_flow/poll", {
        flow_token: started.body.flow_token,
      });
      expect(polled.body).toEqual({ status: "expired" });
      expect(h.polled).toEqual([]);
    });
  });
});
