import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { envFileLaunch } from "../src/cloudflare-bridge";

it("keeps env values out of argv while the child still receives them", () => {
  const secret = "s3cr3t 'quoted' $HOME `x`\nline2";
  const file = join(mkdtempSync(join(tmpdir(), "openma-env-test-")), "env");
  const { argv, content } = envFileLaunch(file, [["VAULT_SECRET", secret], ["PLAIN", "p"]], process.execPath, [
    "-e", "process.stdout.write(JSON.stringify([process.env.VAULT_SECRET, process.env.PLAIN, process.argv.slice(1)]))", "x y",
  ]);
  for (const argument of argv) {
    expect(argument).not.toContain("s3cr3t");
    expect(argument).not.toContain("PLAIN=");
  }
  writeFileSync(file, content);
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([secret, "p", ["x y"]]);
  expect(existsSync(file)).toBe(false);
});

it("fails closed without running the child when the env file is missing", () => {
  const { argv } = envFileLaunch("/nonexistent/openma-env", [["A", "1"]], "sh", ["-c", "echo ran"]);
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  expect(result.status).toBe(127);
  expect(result.stdout).toBe("");
});

it("rejects env names that are not shell identifiers", () => {
  expect(() => envFileLaunch("/f", [["BAD-NAME", "v"]], "true", [])).toThrow("valid identifier");
});
