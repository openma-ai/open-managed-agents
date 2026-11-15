// Cloudflare RunnerRelayPort over the RuntimeRoom Durable Object namespace.
import { describe, expect, it } from "vitest";
import { createRuntimeRoomRelay, RUNTIME_ROOM_BINDING_MISSING } from "../src/runtime/runtime-room-relay";

function namespace(response: { status: number; webSocket?: unknown }) {
  const calls: { name?: string; id?: unknown; request?: Request } = {};
  const ns = {
    idFromName: (name: string) => { calls.name = name; return `id:${name}`; },
    get: (id: unknown) => {
      calls.id = id;
      return { fetch: async (request: Request) => { calls.request = request; return response; } };
    },
  };
  return { ns: ns as unknown as DurableObjectNamespace, calls };
}

describe("RuntimeRoom runner relay", () => {
  it("is unavailable, with the binding message, when the namespace is not bound", async () => {
    expect(await createRuntimeRoomRelay(undefined).attachHarness({ runtimeId: "r", sessionId: "s" }))
      .toEqual({ type: "unavailable", message: RUNTIME_ROOM_BINDING_MISSING });
    expect(RUNTIME_ROOM_BINDING_MISSING).toContain("RUNTIME_ROOM binding missing");
  });

  it("attaches to the runtime's room with the harness headers", async () => {
    const socket = { accept() {}, send() {}, close() {}, addEventListener() {} };
    const { ns, calls } = namespace({ status: 101, webSocket: socket });
    const result = await createRuntimeRoomRelay(ns).attachHarness({
      runtimeId: "runtime_1", sessionId: "sess_1", tenantId: "default", replay: { turn_id: "t", after: { stream: 2 } },
    });
    expect(result).toEqual({ type: "attached", socket });
    expect(calls.name).toBe("runtime_1");
    expect(calls.id).toBe("id:runtime_1");
    expect(calls.request!.url).toBe("http://runtime-room/_attach_harness");
    expect(Object.fromEntries(calls.request!.headers)).toEqual({
      upgrade: "websocket",
      "x-attach-role": "harness",
      "x-session-id": "sess_1",
      "x-harness-tenant": "default",
      "x-runtime-replay": JSON.stringify({ turn_id: "t", after: { stream: 2 } }),
    });
  });

  it("omits tenant and replay headers when absent", async () => {
    const { ns, calls } = namespace({ status: 101, webSocket: {} });
    await createRuntimeRoomRelay(ns).attachHarness({ runtimeId: "r", sessionId: "s" });
    expect(Object.fromEntries(calls.request!.headers)).toEqual({ upgrade: "websocket", "x-attach-role": "harness", "x-session-id": "s" });
  });

  it("reports a refused attach when the room does not upgrade", async () => {
    expect(await createRuntimeRoomRelay(namespace({ status: 404 }).ns).attachHarness({ runtimeId: "r", sessionId: "s" }))
      .toEqual({ type: "refused", status: 404 });
    expect(await createRuntimeRoomRelay(namespace({ status: 101 }).ns).attachHarness({ runtimeId: "r", sessionId: "s" }))
      .toEqual({ type: "refused", status: 101 });
  });
});
