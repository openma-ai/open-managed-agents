import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";

it("executes prepare-context and the release/trust regression suite offline", () => {
  const result = spawnSync(process.execPath, ["--test", new URL("./common-template-chain.test.mjs", import.meta.url).pathname], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 65_000);
