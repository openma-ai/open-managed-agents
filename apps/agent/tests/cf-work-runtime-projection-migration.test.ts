import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
// @ts-expect-error Vite loads production migration SQL as text.
import migration from "../../main/migrations/0031_work_runtime_projection.sql?raw";

it("real workerd D1 expands existing Work without touching tokens, claims or queued input", async () => {
  await exports.default.fetch(new Request("http://localhost/health"));
  await env.MAIN_DB.prepare("INSERT INTO managed_environment_work (workspace_id,environment_id,id,session_id,document,sealed_secret,claim_at,claim_worker_id,claim_generation,heartbeat_ttl_seconds,revision,state,created_at,runtime_publication_json,sandbox_token_hashes) VALUES ('migration','e','unacked','s','{}','sealed',NULL,NULL,0,90,1,'queued',1,'publication','hashes')").run();
  await env.MAIN_DB.prepare("INSERT INTO managed_session_events (workspace_id,session_id,thread_id,id,type,document,processed_at) VALUES ('migration','s',NULL,'input','user.message',?,1)").bind(JSON.stringify({id:"input",type:"user.message",processedAt:null,content:[]})).run();
  const before = await env.MAIN_DB.prepare("SELECT * FROM managed_environment_work WHERE workspace_id='migration'").first<any>();
  const input = await env.MAIN_DB.prepare("SELECT * FROM managed_session_events WHERE workspace_id='migration'").first<any>();
  await env.MAIN_DB.exec(migration);
  expect(await env.MAIN_DB.prepare("SELECT * FROM managed_environment_work WHERE workspace_id='migration'").first()).toEqual({...before,runtime_projection:null});
  expect(await env.MAIN_DB.prepare("SELECT * FROM managed_session_events WHERE workspace_id='migration'").first()).toEqual(input);
  await env.MAIN_DB.prepare("UPDATE managed_environment_work SET runtime_projection=? WHERE workspace_id='migration'").bind('{"checkpoint":1}').run();
  await env.MAIN_DB.prepare("UPDATE managed_environment_work SET revision=revision+1 WHERE workspace_id='migration'").run();
  expect(await env.MAIN_DB.prepare("SELECT runtime_projection,sealed_secret,claim_generation FROM managed_environment_work WHERE workspace_id='migration'").first()).toEqual({runtime_projection:'{"checkpoint":1}',sealed_secret:"sealed",claim_generation:0});
});
