import { expect, it } from "vitest";
import { coldFixture } from "./node-cold-finalization.fixture.js";

it("does not fall back to a workspace archive when the Node provider has no native snapshot", async () => {
  const f = await coldFixture();
  const result = await f.request("checkpoint");
  expect(result.status).toBe(502);
  expect(await result.json()).toMatchObject({ type: "failed" });
  expect(await f.sandbox.exec("test ! -e checkpoint-transfer && printf clean")).toContain("clean");
  const table = await f.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_session_workspace_checkpoints'").first();
  expect(table).toBeNull();
});

it("refuses terminal finalization before a provider-native snapshot exists", async () => {
  const f = await coldFixture();
  const result = await f.request("finalize", { stopReason: { type: "end_turn" } });
  expect(result.status).toBe(502);
  expect(await result.json()).toMatchObject({ type: "failed" });
  const archiveTable = await f.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_session_workspace_checkpoints'").first();
  expect(archiveTable).toBeNull();
});
