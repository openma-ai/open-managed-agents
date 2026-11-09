import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordWorkerSource, sourceFingerprint } from "./record-worker-source.mjs";

test("capture/bind keeps the exact tracked source and refuses stale or reused mappings", () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-fingerprint-"));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  try {
    git("init");
    writeFileSync(join(cwd, "source.txt"), "baseline");
    git("add", "source.txt");
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "baseline");
    const evidence = join(cwd, "evidence.json");
    const captured = recordWorkerSource(["capture", evidence], cwd);
    assert.match(captured.source.head, /^[a-f0-9]{40}$/);
    assert.equal(captured.source.diff_head_sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.throws(() => recordWorkerSource(["capture", evidence], cwd), /EEXIST/);
    writeFileSync(join(cwd, "source.txt"), "changed");
    assert.notEqual(sourceFingerprint(cwd).diff_head_sha256, captured.source.diff_head_sha256);
    assert.throws(() => recordWorkerSource(["bind", evidence, "test-version"], cwd), /Tracked source changed/);
    writeFileSync(join(cwd, "source.txt"), "baseline");
    const bound = recordWorkerSource(["bind", evidence, "test-version"], cwd);
    assert.equal(bound.deployment.worker_version_id, "test-version");
    assert.equal(bound.deployment.source_head, captured.source.head);
    assert.match(bound.deployment.status_short, /evidence.json/);
    assert.throws(() => recordWorkerSource(["bind", evidence, "other-version"], cwd), /already bound/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
