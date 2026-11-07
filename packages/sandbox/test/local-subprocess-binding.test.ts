import { mkdtempSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxFactory } from "../src/adapters/local-subprocess";

const roots: string[] = [];
function context() {
  const root = mkdtempSync(join(tmpdir(), "sandbox-binding-"));
  roots.push(root);
  return { sessionId: "session", allocationId: "allocation-a", workdir: join(root, "workspace") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("local subprocess factory binding", () => {
  it("reopens a serialized workspace identity with a fresh client and no process-memory settings", async () => {
    const ctx = context();
    const first = await sandboxFactory(ctx, {});
    await first.writeFile("retained.txt", "retained content");
    await first.setEnvVars({ ONLY_IN_OLD_CLIENT: "not-persistent" });
    const binding = sandboxFactory.runtimeBinding!;
    const handle = JSON.parse(JSON.stringify(binding.getHandle(first)));
    expect(binding.scope).toBe("host");
    expect(handle.provider).toBe("local-subprocess");
    expect(handle.runtimeId).toMatch(/^[a-f0-9]{64}$/);
    const reopened = await binding.resume(handle, ctx, {});
    expect(reopened).not.toBe(first);
    expect(binding.getHandle(reopened)).toEqual(handle);
    expect(await reopened.readFile("retained.txt")).toBe("retained content");
    expect(await reopened.exec('printf "%s" "${ONLY_IN_OLD_CLIENT-unset}"')).toContain("unset");
  });

  it("rejects foreign hosts, directories and allocations without creating a replacement", async () => {
    const ctx = context();
    const first = await sandboxFactory(ctx, {});
    const binding = sandboxFactory.runtimeBinding!;
    const handle = binding.getHandle(first);
    const foreign = { ...handle, runtimeId: "other-host-workspace-identity" };
    await expect(binding.resume(foreign, ctx, {})).rejects.toThrow("does not match");
    await expect(binding.resume(handle, { ...ctx, allocationId: "allocation-b" }, {})).rejects.toThrow("does not match");
    const other = context();
    await sandboxFactory(other, {});
    await expect(binding.resume(handle, other, {})).rejects.toThrow("does not match");
    rmSync(ctx.workdir, { recursive: true });
    await expect(binding.resume(handle, ctx, {})).rejects.toThrow(/ENOENT/);
  });

  it("refuses a different physical directory reused at the same path", async () => {
    const ctx = context();
    const first = await sandboxFactory(ctx, {});
    const binding = sandboxFactory.runtimeBinding!;
    const handle = binding.getHandle(first);
    renameSync(ctx.workdir, `${ctx.workdir}-old`);
    mkdirSync(ctx.workdir);
    await expect(binding.resume(handle, ctx, {})).rejects.toThrow("does not match");
  });
});
