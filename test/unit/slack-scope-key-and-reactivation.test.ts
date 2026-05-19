// Coverage for the scope-key derivation + scope-row reactivation path.
//
// scopeKeyFor() is the single source of truth for "(event, granularity) →
// scope_key" — replacing the old `event.scopeKey` parser field that bound a
// per_thread shape into the parser. Per_channel needs `channel:${id}`,
// per_thread needs `${channelId}:${threadTs}`, per_event/per_issue have no
// scope at all.
//
// reassignIfInactive is the SQL guard that lets a closed/escalated/etc.
// scope row get re-bound to a fresh session when the next event in the same
// scope creates a new session. Without it, the stale row orphans every
// future session forever.

import { describe, it, expect, beforeEach } from "vitest";
import {
  scopeKeyFor,
  type NormalizedSlackEvent,
} from "../../packages/slack/src/index";
import {
  appMentionPayload,
  buildFakeSlackContainer,
  memberJoinedChannelPayload,
  seedDedicatedSlackPublication,
  type FakeSlackBundle,
} from "./slack-test-helpers";
import { SlackProvider } from "../../packages/slack/src/provider";
import {
  ALL_SLACK_CAPABILITIES,
  DEFAULT_SLACK_BOT_SCOPES,
  DEFAULT_SLACK_USER_SCOPES,
} from "../../packages/slack/src/config";

// ─── scopeKeyFor unit tests ─────────────────────────────────────────────

function eventWith(overrides: Partial<NormalizedSlackEvent>): NormalizedSlackEvent {
  return {
    workspaceId: "T0TEAM",
    appId: "A0APP",
    channelId: "C0CHAN",
    threadTs: "1700000000.000100",
    eventTs: "1700000000.000100",
    userId: "U0USER",
    deliveryId: "Ev_X",
    eventType: "message",
    kind: "app_mention",
    isTopLevel: true,
    isBotMessage: false,
    text: "hi",
    reactionName: null,
    itemTs: null,
    itemUserId: null,
    channelName: null,
    ...overrides,
  } as unknown as NormalizedSlackEvent;
}

describe("scopeKeyFor", () => {
  it("per_channel produces `channel:${channelId}`", () => {
    expect(scopeKeyFor(eventWith({ channelId: "C123" }), "per_channel")).toBe("channel:C123");
  });

  it("per_channel returns null when channelId is missing", () => {
    expect(scopeKeyFor(eventWith({ channelId: null }), "per_channel")).toBeNull();
  });

  it("per_thread produces `${channelId}:${threadTs}` for top-level (threadTs == eventTs)", () => {
    const e = eventWith({
      channelId: "C0",
      threadTs: "1700000000.000100",
      eventTs: "1700000000.000100",
    });
    expect(scopeKeyFor(e, "per_thread")).toBe("C0:1700000000.000100");
  });

  it("per_thread pins to thread_ts for threaded replies (different from eventTs)", () => {
    const e = eventWith({
      channelId: "C0",
      threadTs: "1700000000.000100",
      eventTs: "1700000005.000200",
    });
    expect(scopeKeyFor(e, "per_thread")).toBe("C0:1700000000.000100");
  });

  it("per_thread returns null when threadTs is null (e.g. member_joined_channel)", () => {
    expect(scopeKeyFor(eventWith({ threadTs: null }), "per_thread")).toBeNull();
  });

  it("per_event and per_issue always return null (no scope binding)", () => {
    const e = eventWith({});
    expect(scopeKeyFor(e, "per_event")).toBeNull();
    expect(scopeKeyFor(e, "per_issue")).toBeNull();
  });

  it("returns null when channelId is missing regardless of granularity", () => {
    const e = eventWith({ channelId: null, threadTs: null });
    expect(scopeKeyFor(e, "per_channel")).toBeNull();
    expect(scopeKeyFor(e, "per_thread")).toBeNull();
    expect(scopeKeyFor(e, "per_event")).toBeNull();
  });
});

// ─── reactivation path: closed scope row gets re-bound to new session ───

const APP_SIGNING_SECRET = "ssec";
const CHANNEL = "C0CHAN";
const CHANNEL_SCOPE = `channel:${CHANNEL}`;
const BOT_USER_ID = "U07BOT";

describe("createChannelSession — reactivation of inactive scope rows", () => {
  let c: FakeSlackBundle;
  let provider: SlackProvider;
  let appId: string;
  let pubId: string;

  beforeEach(async () => {
    c = buildFakeSlackContainer();
    c.hmac.verify = async (secret: string, baseString: string, hex: string) =>
      hex === `valid${secret}${baseString}`.toLowerCase().replace(/[^a-f0-9]/g, "");
    provider = new SlackProvider(c, {
      gatewayOrigin: "https://gw",
      botScopes: DEFAULT_SLACK_BOT_SCOPES,
      userScopes: DEFAULT_SLACK_USER_SCOPES,
      defaultCapabilities: ALL_SLACK_CAPABILITIES,
    });
    const seeded = await seedDedicatedSlackPublication(c, {
      signingSecret: APP_SIGNING_SECRET,
      sessionGranularity: "per_channel",
    });
    appId = seeded.appId;
    pubId = seeded.pubId;
    c.clock.set(1_700_000_000_000);
  });

  function validSig(rawBody: string, ts: string): string {
    const baseString = `v0:${ts}:${rawBody}`;
    const hex = `valid${APP_SIGNING_SECRET}${baseString}`
      .toLowerCase()
      .replace(/[^a-f0-9]/g, "");
    return `v0=${hex}`;
  }

  async function deliver(rawBody: string) {
    const ts = "1700000000";
    return await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: {
        "x-slack-signature": validSig(rawBody, ts),
        "x-slack-request-timestamp": ts,
      },
      rawBody,
    });
  }

  it(
    "@-mention after a 'completed' scope row rebinds the row to the new session",
    async () => {
      // 1. Bot joins → creates first session (sess_1), scope row goes active.
      const join = await deliver(
        memberJoinedChannelPayload({ channel: CHANNEL, eventId: "Ev_J", user: BOT_USER_ID }),
      );
      await join.deferredWork!();
      const firstScope = await c.sessionScopes.getByScope(pubId, CHANNEL_SCOPE);
      expect(firstScope?.sessionId).toBe("sess_1");
      expect(firstScope?.status).toBe("active");
      expect(c.sessions.created).toHaveLength(1);

      // 2. Force scope row to a closed state without going through close_session
      //    (simulates an externally-completed session: `completed` after a
      //    session.close, or `escalated` / `failed` / etc. — any non-active
      //    terminal status). The session itself stays around but the row is
      //    stale.
      await c.sessionScopes.updateStatus(pubId, CHANNEL_SCOPE, "completed");

      // 3. New @-mention arrives. classifyDispatch returns `direct_invocation`
      //    for app_mention. dispatchEvent's direct_invocation branch sees
      //    existing non-active row, so it falls into lazy bootstrap →
      //    createChannelSession (sess_2). The insert collides on UNIQUE.
      //    Without reassignIfInactive, sess_2 would be orphaned and the row
      //    would still point at sess_1 forever.
      const mention = await deliver(
        appMentionPayload({
          channel: CHANNEL,
          ts: "1700000050.000100",
          eventId: "Ev_M1",
          text: "<@U07BOT> hello again",
        }),
      );
      await mention.deferredWork!();

      // A second session was created (the new one is sess_2).
      expect(c.sessions.created).toHaveLength(2);

      // The scope row has been re-bound to sess_2 and reactivated.
      const reboundScope = await c.sessionScopes.getByScope(pubId, CHANNEL_SCOPE);
      expect(reboundScope?.sessionId).toBe("sess_2");
      expect(reboundScope?.status).toBe("active");
    },
  );

  it(
    "subsequent @-mentions after reactivation route to the rebound session, not a third",
    async () => {
      // Repeat the join + force-completed setup.
      const join = await deliver(
        memberJoinedChannelPayload({ channel: CHANNEL, eventId: "Ev_J2", user: BOT_USER_ID }),
      );
      await join.deferredWork!();
      await c.sessionScopes.updateStatus(pubId, CHANNEL_SCOPE, "completed");

      // First post-close mention re-binds → sess_2 created + row rebinds.
      const m1 = await deliver(
        appMentionPayload({
          channel: CHANNEL,
          ts: "1700000050.000100",
          eventId: "Ev_M_A",
          text: "<@U07BOT> first after close",
        }),
      );
      await m1.deferredWork!();
      expect(c.sessions.created).toHaveLength(2);
      const reboundScopeAfterM1 = await c.sessionScopes.getByScope(pubId, CHANNEL_SCOPE);
      expect(reboundScopeAfterM1?.sessionId).toBe("sess_2");
      expect(reboundScopeAfterM1?.status).toBe("active");

      // Second post-close mention should resume sess_2, not create a third.
      const resumesBefore = c.sessions.resumed.length;
      const m2 = await deliver(
        appMentionPayload({
          channel: CHANNEL,
          ts: "1700000060.000100",
          eventId: "Ev_M_B",
          text: "<@U07BOT> second after close",
        }),
      );
      await m2.deferredWork!();

      expect(c.sessions.created).toHaveLength(2); // no new session
      const resumedTo = c.sessions.resumed.slice(resumesBefore).map((r) => r.sessionId);
      expect(resumedTo).toContain("sess_2");
      const scope = await c.sessionScopes.getByScope(pubId, CHANNEL_SCOPE);
      expect(scope?.sessionId).toBe("sess_2");
      expect(scope?.status).toBe("active");
    },
  );
});

// Light type-only assertion that the SessionScope domain shape still has
// the fields we depend on. If the domain changes, the test fails to compile,
// which prevents this whole suite from drifting silently.
import type { SessionScope } from "../../packages/integrations-core/src/domain";
const _sessionScopeShape: SessionScope = {
  tenantId: "t",
  publicationId: "p",
  scopeKey: "channel:C0",
  sessionId: "s",
  status: "active",
  createdAt: 0,
  pendingScanUntil: null,
  lastScanAt: null,
  channelName: null,
};
void _sessionScopeShape;
