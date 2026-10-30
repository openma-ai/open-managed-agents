import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as installer from "../../../packages/sandbox-egress/src/install";
import { LocalSubprocessSandbox } from "../../../packages/sandbox/src/adapters/local-subprocess";
import type { ProviderManagedRuntimeOptions } from "../../../packages/managed-runtime-sandbox/src/provider-runtime";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const scope = { workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work" };
const fence = { ...scope, ownerId: "owner", generation: 1, token: "fence-proof", expiresAt: "2099-01-01" };
const signal = new AbortController().signal;

describe("shared provider credential egress adapter", () => {
  it("installs the sandbox process through the resource hook and revokes authority before clearing", async () => {
    expect(typeof installer.createSandboxCredentialEgress).toBe("function");
    const dir = await mkdtemp(join(tmpdir(), "oma-resource-egress-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const runtime = new LocalSubprocessSandbox({ workdir: dir }); cleanup.push(() => runtime.destroy());
    let revoked = false;
    const adapter: NonNullable<ProviderManagedRuntimeOptions<typeof runtime>["credentialEgress"]> = installer.createSandboxCredentialEgress({
      resolve: async input => {
        expect(input.scope).toEqual(scope); expect(input.fence).toEqual(fence);
        return { vaultIds: ["vault"], relay: { endpoint: "https://control.example", pass: "" }, issuePass: async () => "session-pass", placeholders: async () => ({ GITHUB_TOKEN: "__cap_managed__" }) };
      },
      revoke: async () => { expect(await runtime.exec('printf "%s" "$GITHUB_TOKEN"')).toContain("__cap_managed__"); revoked = true; },
    });
    expect(adapter.capabilities).toEqual({ enforcement: "advisory", credentialMode: "live", interceptedProtocols: ["https"] });
    await adapter.attach({ runtime, scope, fence, signal, requirement: "best_effort" });
    expect(await runtime.exec('printf "%s|%s" "$GITHUB_TOKEN" "$HTTPS_PROXY"')).toMatch(/__cap_managed__\|http:\/\/127\.0\.0\.1:\d+/);
    await adapter.revoke({ runtime, scope, fence, reason: "completed" });
    expect(revoked).toBe(true);
    expect(await runtime.exec('printf "%s|%s" "$GITHUB_TOKEN" "$HTTPS_PROXY"')).toBe("|");
  });

  it("rejects required enforcement rather than claiming an environment proxy cannot be bypassed", async () => {
    expect(typeof installer.createSandboxCredentialEgress).toBe("function");
    const adapter = installer.createSandboxCredentialEgress({ resolve: async () => { throw new Error("must not resolve"); }, revoke: async () => {} });
    await expect(adapter.attach({ runtime: {} as LocalSubprocessSandbox, scope, fence, signal, requirement: "required" })).rejects.toThrow(/advisory/);
  });
});
