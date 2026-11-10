import { expect, it, vi } from "vitest";
import type { EgressPolicy } from "@open-managed-agents/sandbox";
import { createOpenSandboxNativeEgress } from "../src/native-egress";

const scope = { workspaceId: "ws", sessionId: "sess", environmentId: "env", workId: "work" };
const fence = { ...scope, ownerId: "owner", generation: 1, token: "token", expiresAt: "2030-01-01T00:00:00Z" };
const policy: EgressPolicy = { scope: { workspaceId: "ws", sessionId: "sess", generation: 1 }, networking: { type: "limited", hosts: ["api.example.com"], packageSources: [], mcpHosts: [] }, substitutions: [{ credentialId: "cred", envName: "API_TOKEN", placeholder: "oma-placeholder", hosts: ["api.example.com"], inject: { header: true, body: false } }] };
const signal = new AbortController().signal;
function fixture() {
  const order: string[] = [];
  const runtime = {};
  const vault = { delete: vi.fn(async () => { order.push("delete"); }), create: vi.fn(async (_body: unknown) => { order.push("create"); return {} as never; }) };
  const env: Record<string, string> = {};
  const vendor = { exec: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), setEnv: vi.fn(async (_r, values) => { Object.assign(env, values); }), applyFirewall: vi.fn(async () => { order.push("firewall"); }) };
  const secrets = { read: vi.fn(async () => ({ value: "secret-value", expiresAt: null as number | null })) };
  const deps = { secrets, gateway: { endpoint: { url: "https://gateway.example" }, issueToken: vi.fn(), authenticate: vi.fn(), handle: vi.fn() } };
  const port = createOpenSandboxNativeEgress(vendor, () => vault, deps);
  const input = { runtime, scope, fence, signal, policy };
  return { port, input, vault, vendor, secrets, env, order };
}
it("maps exact host-scoped HTTPS placeholder replacement, and only places placeholders in env", async () => {
  const f = fixture(); await f.port.attach(f.input);
  expect(f.order).toEqual(["delete", "firewall", "create"]);
  expect(f.vault.create.mock.calls[0]?.[0]).toEqual({ credentials: [{ name: "oma-0", source: { type: "inline", value: "secret-value" } }], bindings: [{ name: "oma-0", match: { schemes: ["https"], hosts: ["api.example.com"] }, auth: { type: "passthrough", substitutions: [{ credential: "oma-0", placeholder: "oma-placeholder", in: ["header"] }] } }] });
  expect(f.env).toEqual({ API_TOKEN: "oma-placeholder" });
});
it("replaces the whole vault on updates, clearing removed grants and env placeholders", async () => {
  const f = fixture(); await f.port.attach(f.input);
  await f.port.update({ ...f.input, policy: { ...policy, substitutions: [] }, changedCredentialIds: ["cred"] });
  expect(f.vault.delete).toHaveBeenCalledTimes(2);
  expect(f.vault.create).toHaveBeenCalledTimes(1);
  expect(f.env.API_TOKEN).toBe("");
});
it("rotates secret bytes even when the credential id is unchanged", async () => {
  const f = fixture(); await f.port.attach(f.input);
  f.secrets.read.mockResolvedValueOnce({ value: "rotated", expiresAt: null });
  await f.port.update({ ...f.input, changedCredentialIds: ["cred"] });
  expect(f.vault.create.mock.calls[1]?.[0]).toMatchObject({ credentials: [{ source: { value: "rotated" } }] });
});
it.each(["completed", "failed", "lease_lost", "checkpoint"] as const)("revokes provider secrets for %s", async reason => {
  const f = fixture(); await f.port.attach(f.input);
  await f.port.revoke({ ...f.input, reason });
  expect(f.vault.delete).toHaveBeenCalledTimes(2); expect(f.env.API_TOKEN).toBe("");
});
it("cleans an ambiguous create failure and never exposes upstream secrets in errors", async () => {
  const f = fixture(); f.vault.create.mockRejectedValueOnce(new Error("request included secret-value"));
  await expect(f.port.attach(f.input)).rejects.toThrow("OpenSandbox native Vault configuration failed");
  expect(f.vault.delete).toHaveBeenCalledTimes(2); expect(f.env.API_TOKEN).not.toBe("secret-value");
});
it("refuses to proceed if old secrets cannot be revoked", async () => {
  const f = fixture(); f.vault.delete.mockRejectedValue(new Error("secret-value"));
  await expect(f.port.attach(f.input)).rejects.toThrow(/revocation failed/);
  expect(f.secrets.read).not.toHaveBeenCalled(); expect(f.vault.create).not.toHaveBeenCalled();
});
it("rejects expiring secrets rather than keeping them past their deadline", async () => {
  const f = fixture(); f.secrets.read.mockResolvedValue({ value: "secret-value", expiresAt: Date.now() + 60_000 });
  await expect(f.port.attach(f.input)).rejects.toThrow(/expiring/);
  expect(f.vault.create).not.toHaveBeenCalled();
});
it("rejects cross-session policy before reading secrets", async () => {
  const f = fixture();
  await expect(f.port.attach({ ...f.input, policy: { ...policy, scope: { ...policy.scope, sessionId: "other" } } })).rejects.toThrow(/scope/);
  expect(f.secrets.read).not.toHaveBeenCalled();
});
it("rejects ambiguous multi-binding policies rather than assuming sidecar first-match semantics", async () => {
  const f = fixture();
  await expect(f.port.attach({ ...f.input, policy: { ...policy, substitutions: [...policy.substitutions, { ...policy.substitutions[0]!, credentialId: "second", envName: "SECOND" }] } })).rejects.toThrow(/one substitution/);
  expect(f.secrets.read).not.toHaveBeenCalled();
});
it("serializes revocation after an in-flight attach so secrets cannot reappear", async () => {
  const f = fixture(); let finish!: () => void;
  f.vault.create.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return {} as never; });
  const attach = f.port.attach(f.input);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const revoke = f.port.revoke({ ...f.input, reason: "lease_lost" });
  finish(); await Promise.all([attach, revoke]);
  expect(f.vault.delete).toHaveBeenCalledTimes(2); expect(f.env.API_TOKEN).toBe("");
});
