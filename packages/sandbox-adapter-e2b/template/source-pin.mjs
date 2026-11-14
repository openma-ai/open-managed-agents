import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
export function sourcePin(sourceSha, lockSha256) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "") || !/^[a-f0-9]{64}$/.test(lockSha256 ?? "")) throw Error("Explicit full source SHA and lock SHA256 required");
  return { sourceSha, lockSha256 };
}
export function verifyRepository(repository, pin) {
  const git = args => {
    const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
    if (result.status !== 0) throw Error("Source git verification failed");
    return result.stdout;
  };
  if (git(["status", "--porcelain", "--untracked-files=normal"]).trim()) throw Error("Dirty source repository rejected");
  if (git(["rev-parse", "HEAD"]).trim() !== pin.sourceSha || git(["rev-parse", pin.sourceSha + "^{commit}"]).trim() !== pin.sourceSha) throw Error("Source repository does not match explicit SHA");
  if (createHash("sha256").update(git(["show", pin.sourceSha + ":pnpm-lock.yaml"])).digest("hex") !== pin.lockSha256) throw Error("Source lock does not match explicit digest");
  return git;
}
