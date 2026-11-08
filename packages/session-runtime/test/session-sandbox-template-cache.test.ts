import { describe, expect, it } from "vitest";
import {
  SessionTemplateCache,
  TEMPLATE_UNUSED_TTL_MS,
  TEMPLATE_USED_TTL_MS,
  templateExpired,
  templateExpiry,
  type TemplateHandle,
} from "../src/session-sandbox-template-cache";

const DAY = 24 * 60 * 60_000;

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    store: {
      get: async (key: string) => data.get(key) ?? null,
      put: async (key: string, value: string) => { data.set(key, value); },
      delete: async (key: string) => { data.delete(key); },
    },
  };
}

function cache(options: { discard?: (handle: TemplateHandle) => Promise<void> } = {}) {
  const perWorkspace = new Map<string, ReturnType<typeof memoryStore>>();
  const storeOf = (workspaceId: string) => perWorkspace.get(workspaceId) ?? perWorkspace.set(workspaceId, memoryStore()).get(workspaceId)!;
  const data = storeOf("ws_1").data;
  let now = 0;
  const built: string[] = [];
  const stores: string[] = [];
  const instance = new SessionTemplateCache<{ id: string }, TemplateHandle>({
    provider: "fake",
    storeFor: (workspaceId) => { stores.push(workspaceId); return storeOf(workspaceId).store; },
    capturable: () => true,
    builder: {
      create: async () => ({ id: "builder" }),
      capture: async (_s, _r, input) => { built.push(`${input.workspaceId}/${input.key}`); return { provider: "fake", id: `tpl_${built.length}` }; },
      destroy: async () => undefined,
    },
    logger: { info: () => undefined, warn: () => undefined },
    op: "test.template",
    clock: { now: () => now },
    ...(options.discard === undefined ? {} : { discard: options.discard }),
  });
  const create = async (workspaceId = "ws_1") => {
    let from: TemplateHandle | undefined;
    await instance.create({ workspaceId, key: "k1", fields: {}, request: { builderScope: {} } }, async (template) => { from = template; return { id: "s" }; });
    await instance.idle();
    return from;
  };
  return { instance, data, built, stores, create, advance: (ms: number) => { now += ms; } };
}

describe("templateExpiry", () => {
  it("defaults to 7 days unused and 14 days used", () => {
    expect(templateExpiry({})).toEqual({ unusedTtlMs: 7 * DAY, usedTtlMs: 14 * DAY });
    expect(TEMPLATE_UNUSED_TTL_MS).toBe(7 * DAY);
    expect(TEMPLATE_USED_TTL_MS).toBe(14 * DAY);
  });

  it("refuses windows above the provider's snapshot retention or not positive", () => {
    expect(() => templateExpiry({ maxRetentionMs: 10 * DAY })).toThrow(/usedTtlMs .* exceeds the provider's snapshot retention/);
    expect(templateExpiry({ maxRetentionMs: 30 * DAY })).toEqual({ unusedTtlMs: 7 * DAY, usedTtlMs: 14 * DAY });
    expect(() => templateExpiry({ unusedTtlMs: 0 })).toThrow(/positive integer/);
  });

  it("measures an unused template from its build and a used one from its last use", () => {
    const ttl = { unusedTtlMs: 10, usedTtlMs: 20 };
    expect(templateExpired({ createdAtMs: 0 }, ttl, 9)).toBe(false);
    expect(templateExpired({ createdAtMs: 0 }, ttl, 10)).toBe(true);
    expect(templateExpired({ createdAtMs: 0, lastUsedAtMs: 15 }, ttl, 34)).toBe(false);
    expect(templateExpired({ createdAtMs: 0, lastUsedAtMs: 15 }, ttl, 35)).toBe(true);
  });
});

describe("SessionTemplateCache", () => {
  it("scopes templates to the workspace", async () => {
    const c = cache();
    expect(await c.create("ws_1")).toBeUndefined();
    expect(await c.create("ws_2")).toBeUndefined();
    expect(await c.create("ws_1")).toEqual({ provider: "fake", id: "tpl_1" });
    expect(c.built).toEqual(["ws_1/k1", "ws_2/k1"]);
    expect(new Set(c.stores)).toEqual(new Set(["ws_1", "ws_2"]));
  });

  it("discards an expired template and drops its entry before rebuilding", async () => {
    const discarded: string[] = [];
    const c = cache({ discard: async (handle) => { discarded.push(handle.id); } });
    await c.create();
    c.advance(7 * DAY);
    expect(await c.create()).toBeUndefined();
    expect(discarded).toEqual(["tpl_1"]);
    expect(c.built).toHaveLength(2);
  });

  it("records a use at most hourly", async () => {
    const c = cache();
    await c.create();
    const key = [...c.data.keys()][0]!;
    c.advance(DAY);
    await c.create();
    expect(JSON.parse(c.data.get(key)!).lastUsedAtMs).toBe(DAY);
    c.advance(30 * 60_000);
    await c.create();
    expect(JSON.parse(c.data.get(key)!).lastUsedAtMs).toBe(DAY);
    c.advance(31 * 60_000);
    await c.create();
    expect(JSON.parse(c.data.get(key)!).lastUsedAtMs).toBe(DAY + 61 * 60_000);
  });
});
