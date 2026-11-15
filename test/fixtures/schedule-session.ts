import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

const headers = { "x-api-key": "test-key", "content-type": "application/json" };
async function api(path: string, body?: unknown) {
  const response = await exports.default.fetch(new Request(`http://localhost${path}`, {
    headers,
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  }));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<{ id: string; data: unknown[] }>;
}

/** Real migration/bootstrap and canonical Session creation, not an empty DO. */
export async function createScheduleSession(label: string) {
  const agent = await api("/v1/oma/agents", {
    name: `schedule-${label}-${crypto.randomUUID()}`,
    model: "claude-sonnet-4-6",
    system: "Schedule integration test",
    _oma: { harness: "multi-msg" },
  });
  const environment = await api("/v1/environments", {
    name: `schedule-${label}`, config: { type: "cloud" },
  });
  const session = await api("/v1/sessions", { agent: agent.id, environment_id: environment.id });
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", session.id])));
  await runInDurableObject(stub, async (instance) => {
    await instance._sandboxWarm;
  });
  return { stub, sessionId: session.id };
}
