#!/usr/bin/env node
// Capture BEFORE deployment; bind its returned Worker Version ID only AFTER
// deployment succeeds. Neither command deploys or accesses stack.lock.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function sourceFingerprint(cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  if (git("ls-files", "--others", "--exclude-standard", "-z").length > 0) {
    throw new Error("Untracked non-ignored files exist; move evidence outside the checkout or ignore it before capture/bind");
  }
  return {
    head: git("rev-parse", "HEAD").toString().trim(),
    status_short: git("status", "--short").toString(),
    // Exact bytes from git diff HEAD, equivalent to git diff HEAD | shasum -a 256.
    diff_head_sha256: createHash("sha256").update(git("diff", "HEAD")).digest("hex"),
  };
}

export function recordWorkerSource(args, cwd = process.cwd()) {
  const [mode, path, versionId] = args;
  if (!path || !["capture", "bind"].includes(mode) || (mode === "bind" && !versionId)) {
    throw new Error("Usage: node scripts/record-worker-source.mjs capture <evidence.json> | bind <evidence.json> <Worker-Version-ID>");
  }
  const source = sourceFingerprint(cwd);
  if (mode === "capture") {
    const evidence = { captured_at: new Date().toISOString(), source };
    writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
    return evidence;
  }
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  // Untracked non-ignored files are refused without printing names or content.
  // Tracked source must stay unchanged between capture and binding.
  if (evidence.source.head !== source.head || evidence.source.diff_head_sha256 !== source.diff_head_sha256) {
    throw new Error("Tracked source changed after capture; do not bind this deployment to that fingerprint");
  }
  if (evidence.deployment) throw new Error("Worker version already bound; capture a new evidence file");
  evidence.deployment = { worker_version_id: versionId, source_head: source.head, source_diff_head_sha256: source.diff_head_sha256, bound_at: new Date().toISOString(), status_short: source.status_short };
  writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(recordWorkerSource(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
