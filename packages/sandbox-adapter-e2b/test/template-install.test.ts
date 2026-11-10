import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

describe("production template closure", () => {
  it("rejects incomplete, writable, tampered or workspace-linked trusted installs", () => {
    const root = mkdtempSync(join(process.cwd(), "test/.install-"));
    try {
      const check = () => execFileSync("/usr/bin/python3", [new URL("../template/verify-install.py", import.meta.url).pathname, root], { encoding: "utf8", stdio: "pipe" });
      expect(() => check()).toThrow(/verify-install|installation/);
      mkdirSync(join(root, "opt/oma-managed/worker"), { recursive: true });
      writeFileSync(join(root, "opt/oma-managed/worker/node-e2b-work-item-cli.js"), "not-certified");
      expect(check).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("requires an explicit prepared worker context instead of silently building a generic launcher template", async () => {
    const modulePath = "../template/template.mjs";
    const { managedTemplate } = await import(modulePath);
    expect(() => managedTemplate({})).toThrow(/prepared|context/i);
  });
});
