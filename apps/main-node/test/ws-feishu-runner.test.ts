import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  NewInstallation,
  Publication,
  WebhookEventStore,
} from "@open-managed-agents/integrations-core";
import type {
  FeishuInstallationRepo,
  FeishuPublicationRepo,
  FeishuProvider,
  NormalizedFeishuEvent,
} from "@open-managed-agents/feishu";
import {
  startFeishuWsRunner,
  type FeishuWsConnectionFactory,
  type FeishuWsEventHandlers,
} from "../src/lib/ws-feishu-runner";

// Unit tests for the Feishu WS runner's orchestration: envelope
// reconstruction, dedup, status flip, backoff retry, and error isolation.
// No real socket — a FakeFactory captures handlers and controls start().

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A flattened SDK-style frame; reconstructEnvelope maps it back to nested. */
function flatFrame(o: { messageId?: string; text?: string; appId?: string } = {}): unknown {
  const messageId = o.messageId ?? "om_1";
  return {
    schema: "2.0",
    type: "im.message.receive_v1",
    event_id: `ev_${messageId}`,
    app_id: o.appId ?? "cli_a",
    create_time: "1700000000",
    message: {
      message_id: messageId,
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: o.text ?? "hello" }),
    },
    sender: { sender_id: { open_id: "ou_x" }, sender_type: "user" },
  };
}

function makePub(over: Partial<Publication> & { id: string; appId: string }): Publication {
  return {
    id: over.id,
    tenantId: "tnt_1",
    userId: "u_1",
    agentId: "a_1",
    environmentId: "e_1",
    installationId: "",
    status: "live",
    sessionGranularity: "per_chat_user",
    providerId: "feishu",
    mode: "full",
    persona: { name: "Bot", avatarUrl: null },
    capabilities: new Set(),
    ...over,
  } as unknown as Publication;
}

class FakePubs {
  appSecrets = new Map<string, string | null>(); // pubId -> secret
  pubsByAppId = new Map<string, Publication>(); // appId -> pub
  bindCalls: Array<{ publicationId: string; installationId: string }> = [];
  /** Mirrors the real repo: bindInstallation flips the row to live. */
  onBind?: (publicationId: string) => void;
  getAppSecret = async (pubId: string): Promise<string | null> =>
    this.appSecrets.get(pubId) ?? null;
  findByAppId = async (appId: string): Promise<Publication | null> =>
    this.pubsByAppId.get(appId) ?? null;
  bindInstallation = async (input: {
    publicationId: string;
    installationId: string;
  }): Promise<void> => {
    this.bindCalls.push(input);
    this.onBind?.(input.publicationId);
  };
}

class FakeInstallations {
  byAppId = new Map<string, { id: string }>();
  insertCalls = 0;
  findByAppId = async (appId: string) => this.byAppId.get(appId) ?? null;
  insert = async (_row: NewInstallation): Promise<{ id: string }> => {
    const id = `inst_${++this.insertCalls}`;
    return { id };
  };
}

class FakeEvents {
  private seen = new Set<string>();
  attachPublicationCalls: string[] = [];
  attachErrorCalls: Array<{ id: string; err: string }> = [];
  recordIfNew = async (id: string): Promise<boolean> => {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  };
  attachSession = async (_id: string, _sid: string): Promise<void> => {};
  attachPublication = async (id: string, _pub: string): Promise<void> => {
    this.attachPublicationCalls.push(id);
  };
  attachError = async (id: string, err: string): Promise<void> => {
    this.attachErrorCalls.push({ id, err });
  };
}

class FakeFactory {
  handlersByApp = new Map<string, FeishuWsEventHandlers>();
  startImpls = new Map<string, () => Promise<void>>(); // appId -> start behavior
  starts = new Map<string, number>(); // appId -> start count
  stoppedApps = new Set<string>(); // appIds whose connection.stop() was called
  create: FeishuWsConnectionFactory["create"] = ({ appId, handlers }) => {
    this.handlersByApp.set(appId, handlers);
    const self = this;
    return {
      async start() {
        self.starts.set(appId, (self.starts.get(appId) ?? 0) + 1);
        const impl = self.startImpls.get(appId);
        if (impl) await impl();
      },
      async stop() {
        self.stoppedApps.add(appId);
      },
    };
  };
}

function makeSql(rows: () => Array<{ id: string; app_id: string | null; status?: string }>): SqlClient {
  return {
    prepare: (_q: string) => ({
      all: async <T>(): Promise<{ results: T[] }> =>
        ({ results: rows() as unknown as T[] }) as { results: T[] },
    }),
  } as unknown as SqlClient;
}

describe("ws-feishu-runner", () => {
  let clock: { t: number };
  let pubs: FakePubs;
  let installations: FakeInstallations;
  let webhookEvents: FakeEvents;
  let dispatchCalls: NormalizedFeishuEvent[];
  let provider: FeishuProvider;
  let factory: FakeFactory;
  let rows: Array<{ id: string; app_id: string | null; status?: string }>;
  let sql: SqlClient;
  let runners: Array<{ stop: () => Promise<void> }>;

  beforeEach(() => {
    clock = { t: 1_000 };
    pubs = new FakePubs();
    installations = new FakeInstallations();
    webhookEvents = new FakeEvents();
    dispatchCalls = [];
    provider = {
      dispatchEvent: async (event: NormalizedFeishuEvent) => {
        dispatchCalls.push(event);
      },
    } as unknown as FeishuProvider;
    factory = new FakeFactory();
    rows = [];
    sql = makeSql(() => rows);
    runners = [];
    pubs.onBind = (pid) => {
      for (const r of rows) if (r.id === pid) r.status = "live";
    };
  });

  afterEach(async () => {
    await Promise.all(runners.map((r) => r.stop().catch(() => {})));
    runners = [];
  });

  async function start(opts: { rescanMs?: number; backoff?: { min: number; max: number } } = {}) {
    const r = await startFeishuWsRunner({
      sql,
      pubs: pubs as unknown as FeishuPublicationRepo,
      installations: installations as unknown as FeishuInstallationRepo,
      webhookEvents: webhookEvents as unknown as WebhookEventStore,
      provider,
      nowMs: () => clock.t,
      rescanMs: opts.rescanMs ?? 10,
      backoff: opts.backoff,
      connectionFactory: factory as unknown as FeishuWsConnectionFactory,
    });
    runners.push(r);
    return r;
  }

  function seed(pub: Publication & { appId: string }, secret: string | null) {
    pubs.pubsByAppId.set(pub.appId, pub);
    pubs.appSecrets.set(pub.id, secret);
    rows = [{ id: pub.id, app_id: pub.appId, status: pub.status }];
  }

  it("reconnects the flattened SDK payload to parseWsFrame and dispatches", async () => {
    seed(makePub({ id: "pub_1", appId: "cli_a", status: "live", installationId: "inst_0" }), "secret");
    await start();
    await sleep(20); // first tick → connect → handshake ok

    factory.handlersByApp.get("cli_a")!.onMessage(flatFrame());
    await sleep(15);

    expect(dispatchCalls).toHaveLength(1);
    const ev = dispatchCalls[0]!;
    expect(ev.kind).toBe("im.message.receive_v1");
    expect(ev.deliveryId).toBe("om_1");
    expect(ev.appId).toBe("cli_a");
    expect(ev.chatId).toBe("oc_chat");
    expect(ev.chatType).toBe("p2p");
    expect(ev.senderOpenId).toBe("ou_x");
    expect(ev.text).toBe("hello");
    expect(webhookEvents.attachPublicationCalls).toEqual(["om_1"]);
  });

  it("dedups re-delivered frames by deliveryId (message_id)", async () => {
    seed(makePub({ id: "pub_1", appId: "cli_a", status: "live", installationId: "inst_0" }), "secret");
    await start();
    await sleep(20);

    const h = factory.handlersByApp.get("cli_a")!;
    h.onMessage(flatFrame()); // om_1
    h.onMessage(flatFrame()); // om_1 again (Feishu re-push on 3s deadline)
    await sleep(15);

    expect(dispatchCalls).toHaveLength(1);
  });

  it("flips awaiting_install → live on a successful handshake (creates installation)", async () => {
    seed(
      makePub({ id: "pub_1", appId: "cli_a", status: "awaiting_install", installationId: "" }),
      "secret",
    );
    await start();
    await sleep(20); // handshake ok → flip

    expect(installations.insertCalls).toBe(1); // no prior installation row
    expect(pubs.bindCalls).toEqual([
      { publicationId: "pub_1", installationId: "inst_1" },
    ]);
  });

  it("does not flip when the publication is already live", async () => {
    seed(makePub({ id: "pub_1", appId: "cli_a", status: "live", installationId: "inst_0" }), "secret");
    await start();
    await sleep(20);

    expect(installations.insertCalls).toBe(0);
    expect(pubs.bindCalls).toHaveLength(0);
  });

  it("reuses an existing installation row instead of inserting a duplicate", async () => {
    installations.byAppId.set("cli_a", { id: "inst_existing" });
    seed(
      makePub({ id: "pub_1", appId: "cli_a", status: "awaiting_install", installationId: "" }),
      "secret",
    );
    await start();
    await sleep(20);

    expect(installations.insertCalls).toBe(0); // found by appId, no insert
    expect(pubs.bindCalls).toEqual([
      { publicationId: "pub_1", installationId: "inst_existing" },
    ]);
  });

  it("does not retry a failed handshake before backoff elapses, then retries", async () => {
    factory.startImpls.set("cli_a", () => Promise.reject(new Error("bad creds")));
    seed(
      makePub({ id: "pub_1", appId: "cli_a", status: "awaiting_install", installationId: "" }),
      "secret",
    );
    await start({ rescanMs: 10, backoff: { min: 1_000, max: 30_000 } });
    await sleep(20); // first tick → start fails (attempt 1)

    expect(factory.starts.get("cli_a")).toBe(1);
    expect(pubs.bindCalls).toHaveLength(0); // no flip on failure

    // Clock advances less than the 2s backoff (attempt 1 → 2s) → no retry.
    clock.t += 500;
    await sleep(20);
    expect(factory.starts.get("cli_a")).toBe(1);

    // Past backoff → the next tick retries the handshake.
    clock.t += 3_000;
    await sleep(20);
    expect(factory.starts.get("cli_a")!).toBeGreaterThanOrEqual(2);
  });

  it("isolates dispatch failures (attachError) without killing the loop", async () => {
    provider = {
      dispatchEvent: async () => {
        throw new Error("dispatch boom");
      },
    } as unknown as FeishuProvider;
    seed(makePub({ id: "pub_1", appId: "cli_a", status: "live", installationId: "inst_0" }), "secret");
    await start();
    await sleep(20);

    const h = factory.handlersByApp.get("cli_a")!;
    h.onMessage(flatFrame({ messageId: "om_1" }));
    await sleep(15);
    h.onMessage(flatFrame({ messageId: "om_2", text: "two" }));
    await sleep(15);

    expect(webhookEvents.attachErrorCalls).toEqual([
      { id: "om_1", err: "dispatch boom" },
      { id: "om_2", err: "dispatch boom" },
    ]);
    expect(dispatchCalls).toHaveLength(0); // provider stub never succeeded
  });

  it("flips a pending row that appears while the connection is already live (no restart)", async () => {
    seed(makePub({ id: "pub_1", appId: "cli_a", status: "live", installationId: "inst_0" }), "secret");
    await start();
    await sleep(20); // handshake ok, connection live

    // Wizard completes for a NEW publication on the same app while the
    // runner is up (e.g. re-publish after an unpublish). The old code
    // only flipped inside the handshake callback → this row hung at
    // credentials_filled until a process restart.
    const pending = makePub({ id: "pub_2", appId: "cli_a", status: "credentials_filled", installationId: "" });
    pubs.pubsByAppId.set("cli_a", pending);
    pubs.appSecrets.set("pub_2", "secret");
    rows = [{ id: "pub_2", app_id: "cli_a", status: "credentials_filled" }];
    await sleep(20); // next tick: live connection + pending row → flip

    expect(pubs.bindCalls).toEqual([
      { publicationId: "pub_2", installationId: "inst_1" },
    ]);
  });

  it("drops a connection when its publication leaves the target set", async () => {
    seed(makePub({ id: "pub_1", appId: "cli_a", status: "live", installationId: "inst_0" }), "secret");
    const runner = await start();
    await sleep(20);
    expect(factory.stoppedApps.has("cli_a")).toBe(false);

    // Publication flips to a non-target status (e.g. unpublished).
    rows = [];
    await sleep(20); // next tick sees empty target set → stops + drops cli_a
    expect(factory.stoppedApps.has("cli_a")).toBe(true);

    await runner.stop();
    runners.length = 0; // already stopped
  });
});
