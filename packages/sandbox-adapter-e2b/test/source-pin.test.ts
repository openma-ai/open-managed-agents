import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

it("accepts an explicit different commit and rejects floating, mismatched lock, dirty and nonmatching sources", async () => {
  const modulePath = "../template/source-pin.mjs";
  const { sourcePin, verifyRepository } = await import(modulePath);
  const root = mkdtempSync(join(process.cwd(), "test/.pin-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "pin fixture");
    const sha = git("rev-parse", "HEAD");
    const hash = createHash("sha256").update("lockfileVersion: '9.0'\n").digest("hex");
    expect(() => verifyRepository(root, sourcePin(sha, hash))).not.toThrow();
    expect(() => sourcePin("HEAD", hash)).toThrow();
    expect(() => verifyRepository(root, sourcePin(sha, "0".repeat(64)))).toThrow(/lock/i);
    expect(() => verifyRepository(root, sourcePin("1".repeat(40), hash))).toThrow(/match/i);
    writeFileSync(join(root, "untracked"), "dirty");
    expect(() => verifyRepository(root, sourcePin(sha, hash))).toThrow(/dirty/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
