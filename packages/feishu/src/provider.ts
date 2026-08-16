// FeishuProvider — implements integrations-core's IntegrationProvider for
// Feishu. Mirrors packages/slack/src/provider.ts but adapted for Feishu's
// auth model:
//
//   - No OAuth — credentials are App ID + App Secret + Verification Token +
//     Encrypt Key (the latter two are Feishu's URL verification signing
//     material). The install row carries the tenant_access_token, cached
//     with a 2h TTL (refreshed on 401 by the WS runner / client).
//
//   - Production ingest is the WebSocket long-poll runner (in
//     apps/main-node/src/lib/ws-feishu-runner.ts). The HTTP webhook handler
//     in apps/integrations is for the legacy URL verification handshake
//     only; dispatchEvent is not exercised in production today.
//
//   - session_granularity is per_chat (group) or per_chat_user (DM) —
//     Feishu has no Slack-style threads. scopeKey = `chat:${chat_id}` or
//     `chat:${chat_id}:user:${open_id}`.
//
//   - First-class state: `pending_setup → credentials_filled →
//     awaiting_install → live`. credentials_filled → awaiting_install is
//     driven by the Console wizard's "publish" step; awaiting_install →
//     live is driven by the WS runner's test-ping success.

import type {
  Container,
  ContinueInstallInput,
  IntegrationProvider,
  InstallComplete,
  InstallStep,
  McpScope,
  McpToolDescriptor,
  McpToolResult,
  Publication,
  StartInstallInput,
  WebhookOutcome,
  WebhookRequest,
} from "@open-managed-agents/integrations-core";

import { FeishuApiClient } from "./api/client";
import {
  ALL_FEISHU_CAPABILITIES,
  DEFAULT_FEISHU_SCOPES,
  DEFAULT_FEISHU_SUBSCRIBED_EVENTS,
  type FeishuCapabilityKey,
  type FeishuConfig,
} from "./config";
import {
  validateFeishuAppCredentials,
  normalizeFeishuAppCredentials,
} from "./oauth/credentials";
import type {
  FeishuInstallationRepo,
  FeishuPublicationRepo,
  FeishuSessionScopeRepo,
} from "./ports";
import { FEISHU_SIGNAL_PROTOCOL_PROMPT } from "./signal";
import {
  computeEncryptKeyChallenge,
  computeVerificationTokenChallenge,
  detectSigningMode,
} from "./webhook/signature";
import { parseWebhook } from "./webhook/parse";
import { scopeKeyFor } from "./scope";

const PROVIDER_ID = "feishu" as const;

/**
 * Extended container required by FeishuProvider. Adds the three Feishu-
 * specific repo variants on top of the base `Container`. Wire layer
 * constructs one per integration gateway request.
 */
export interface FeishuContainer extends Container {
  feishuInstallations: FeishuInstallationRepo;
  feishuPublications: FeishuPublicationRepo;
  feishuSessionScopes: FeishuSessionScopeRepo;
}

export class FeishuProvider implements IntegrationProvider {
  readonly id = PROVIDER_ID;

  constructor(
    private readonly cfg: FeishuConfig,
    private readonly container: FeishuContainer,
  ) {}

  // ─── Install flow ──────────────────────────────────────────────────────

  async startInstall(input: StartInstallInput): Promise<InstallStep> {
    // Shell create — same pattern as Slack's startPublication.
    const pub = await this.container.feishuPublications.insertShell({
      tenantId: await this.container.tenants.resolveByUserId(input.userId),
      userId: input.userId,
      agentId: input.agentId,
      environmentId: input.environmentId,
      persona: input.persona,
      capabilities: new Set<FeishuCapabilityKey>(this.cfg.defaultCapabilities),
      sessionGranularity:
        this.cfg.defaultSessionGranularity ?? "per_chat_user",
    });
    return {
      kind: "step",
      step: "credentials_form",
      data: {
        formToken: await this.container.jwt.sign(
          {
            publicationId: pub.id,
            userId: input.userId,
            persona: input.persona,
            returnUrl: input.returnUrl,
          },
          60 * 60, // 1h
        ),
        publicationId: pub.id,
        requiredFields: ["appId", "appSecret"],
        optionalFields: ["encryptKey", "verificationToken"],
      },
    };
  }

  async continueInstall(
    input: ContinueInstallInput,
  ): Promise<InstallStep | InstallComplete> {
    const payload = input.payload as
      | {
          kind?: string;
          formToken?: string;
          appId?: string;
          appSecret?: string;
          verificationToken?: string;
          encryptKey?: string;
          installationId?: string;
          publicationId?: string;
          userId?: string;
          returnUrl?: string;
        }
      | undefined;
    if (!payload) {
      throw new Error("feishu continueInstall requires payload");
    }

    // Resume path: re-mint the formToken for an existing publication shell.
    // The Console wizard hits this when landing with `?pub=<id>` — it must
    // re-mint the JWT against the row's current state WITHOUT inserting a new
    // shell, so a half-finished publication is resumed rather than orphaned.
    // Discriminated by `kind`, mirroring Slack/GitHub's continueInstall; the
    // bridge's `form-token` mode forwards {kind, publicationId, userId,
    // returnUrl}. No credentials are submitted here — Stage 1/2 below stay
    // untouched.
    if (payload.kind === "reissue_form_token") {
      return this.reissueFormToken({
        publicationId: payload.publicationId ?? input.publicationId ?? "",
        userId: payload.userId ?? "",
        returnUrl: payload.returnUrl ?? "",
      });
    }

    // Stage 1: credentials submit (status: pending_setup → credentials_filled).
    // The /credentials route calls this with `publicationId: null`; the
    // publicationId is resolved FROM the formToken JWT (mirrors slack's
    // submitCredentials). The defensive cross-check only fires if the caller
    // also passes an explicit publicationId — none do today.
    if (payload.formToken && payload.appId && payload.appSecret) {
      const claims = await this.container.jwt.verify<{
        publicationId: string;
        userId: string;
      }>(payload.formToken);
      const publicationId = claims.publicationId;
      if (!publicationId) {
        throw new Error(
          "feishu submit_credentials: formToken missing publicationId — restart the publish flow",
        );
      }
      if (input.publicationId && input.publicationId !== publicationId) {
        throw new Error("feishu form token publicationId mismatch");
      }
      const errors = validateFeishuAppCredentials(payload);
      if (errors) {
        return {
          kind: "step",
          step: "credentials_form",
          data: {
            formToken: payload.formToken,
            publicationId,
            errors,
          },
        };
      }
      const normalized = normalizeFeishuAppCredentials({
        appId: payload.appId,
        appSecret: payload.appSecret,
        verificationToken: payload.verificationToken ?? null,
        encryptKey: payload.encryptKey ?? null,
      });
      // One Feishu App backs exactly one live bot: the WS connection and
      // inbound routing are keyed by app_id. Reject early with a clear
      // error instead of letting the new publication silently hang
      // behind the live one (it would never flip).
      const inUse = await this.container.feishuPublications.findByAppId(
        normalized.appId,
      );
      if (inUse && inUse.status === "live" && inUse.id !== publicationId) {
        throw new Error(
          `app_in_use: Feishu App ${normalized.appId} already backs a live bot — unpublish it first (one app = one bot)`,
        );
      }
      await this.container.feishuPublications.setCredentials(publicationId, {
        appId: normalized.appId,
        appSecretCipher: await this.container.crypto.encrypt(
          normalized.appSecret,
        ),
        verificationTokenCipher: normalized.verificationToken
          ? await this.container.crypto.encrypt(normalized.verificationToken)
          : "",
        encryptKeyCipher: await this.container.crypto.encrypt(
          normalized.encryptKey ?? "",
        ),
      });
      return {
        kind: "step",
        step: "install_link",
        data: {
          publicationId,
          // Feishu apps are configured in the developer portal — direct
          // admins there. No URL handshake.
          deeplink: "https://open.feishu.cn/app",
        },
      };
    }

    // Stage 2: completeInstall — called by the WS runner once test-ping OKs.
    // Unlike Stage 1, the WS runner supplies a real publicationId (it does
    // not carry the browser formToken).
    const publicationId = input.publicationId;
    if (!publicationId) {
      throw new Error(
        "feishu continueInstall (completeInstall) requires publicationId",
      );
    }
    if (payload.installationId) {
      await this.container.feishuPublications.bindInstallation({
        publicationId,
        installationId: payload.installationId,
      });
      return {
        kind: "complete",
        publicationId,
      };
    }

    throw new Error("feishu continueInstall: unknown payload shape");
  }

  /**
   * Re-mint a formToken for an existing Feishu publication shell (resume
   * path). Caller — the install bridge's `form-token` mode — is responsible
   * for the ownership gate; this method re-validates existence + a resumable
   * status as defense-in-depth, mirroring SlackProvider.reissueFormToken. No
   * new shell row is inserted; the same publication id flows back through the
   * wizard. Returns the same `credentials_form` step shape as `startInstall`.
   */
  async reissueFormToken(input: {
    publicationId: string;
    userId: string;
    returnUrl: string;
  }): Promise<InstallStep> {
    if (!input.publicationId) {
      throw new Error("reissueFormToken: publicationId required");
    }
    if (!input.userId) {
      throw new Error("reissueFormToken: userId required");
    }
    const pub = await this.container.feishuPublications.get(input.publicationId);
    if (!pub) {
      throw new Error(`reissueFormToken: unknown publicationId ${input.publicationId}`);
    }
    if (pub.userId !== input.userId) {
      throw new Error("reissueFormToken: publication owner mismatch");
    }
    if (
      pub.status !== "pending_setup" &&
      pub.status !== "credentials_filled" &&
      pub.status !== "awaiting_install"
    ) {
      throw new Error(`reissueFormToken: publication is '${pub.status}', cannot resume`);
    }
    const formToken = await this.container.jwt.sign(
      {
        publicationId: pub.id,
        userId: input.userId,
        persona: pub.persona,
        returnUrl: input.returnUrl,
      },
      60 * 60, // 1h — matches startInstall
    );
    return {
      kind: "step",
      step: "credentials_form",
      data: {
        formToken,
        publicationId: pub.id,
        requiredFields: ["appId", "appSecret"],
        optionalFields: ["encryptKey", "verificationToken"],
      },
    };
  }

  // ─── Webhook handler (legacy HTTP path — production ingest is the WS runner) ──

  async handleWebhook(req: WebhookRequest): Promise<WebhookOutcome> {
    // Parse the body — accept only the URL verification handshake + the
    // event_callback shape. Anything else is silently dropped (200).
    let raw: unknown;
    try {
      raw = JSON.parse(req.rawBody);
    } catch {
      return { handled: false, reason: "invalid_json" };
    }
    const event = parseWebhook(raw);
    if (!event) {
      return { handled: false, reason: "unknown_envelope" };
    }
    // URL verification: respond with the challenge within 3 sec (legacy
    // path; the WS runner does not require this).
    if (event.kind === "url_verification" && event.challenge) {
      // Resolve the publication by the verification token in the body.
      const urlToken = (raw as { token?: string }).token ?? null;
      if (!urlToken) {
        return { handled: false, reason: "missing_token" };
      }
      const pub = await this.findPublicationByVerificationToken(urlToken);
      if (!pub) {
        return { handled: false, reason: "unknown_token" };
      }
      const encryptKey = await this.container.feishuPublications.getEncryptKey(
        pub.id,
      );
      const verificationToken =
        await this.container.feishuPublications.getVerificationToken(pub.id);
      const mode = detectSigningMode(encryptKey, verificationToken);
      const challengeResponse =
        mode === "encrypt_key" && encryptKey
          ? await computeEncryptKeyChallenge(encryptKey, event.challenge)
          : computeVerificationTokenChallenge(event.challenge);
      return {
        handled: true,
        publicationId: pub.id,
        tenantId: pub.tenantId,
        challengeResponse,
      };
    }
    // For non-URL-verification events on the HTTP path, just record the
    // dedup row and return 200 — the WS runner is the canonical ingest.
    if (!event.appId) {
      return { handled: false, reason: "missing_app_id" };
    }
    const pub = await this.container.feishuPublications.findByAppId(
      event.appId,
    );
    if (!pub) {
      return { handled: false, reason: "unknown_app" };
    }
    const isNew = await this.container.webhookEvents.recordIfNew(
      event.deliveryId,
      pub.tenantId,
      pub.installationId,
      event.kind,
      this.container.clock.nowMs(),
    );
    if (!isNew) {
      return {
        handled: true,
        publicationId: pub.id,
        tenantId: pub.tenantId,
        reason: "duplicate",
      };
    }
    await this.container.webhookEvents.attachPublication(
      event.deliveryId,
      pub.id,
    );
    return {
      handled: true,
      publicationId: pub.id,
      tenantId: pub.tenantId,
      deferredWork: async () => {
        try {
          await this.dispatchEvent(event, pub);
        } catch (err) {
          await this.container.webhookEvents.attachError(
            event.deliveryId,
            err instanceof Error ? err.message : String(err),
          );
        }
      },
    };
  }

  // ─── MCP tools (minimal MVP — read + send message only) ──────────────

  async mcpTools(_scope: McpScope): Promise<ReadonlyArray<McpToolDescriptor>> {
    return [
      {
        name: "mcp__feishu__im_message_send",
        description:
          "Send a plain-text message into a Feishu chat. Returns the new message_id.",
        inputSchema: {
          type: "object",
          properties: {
            chat_id: { type: "string", description: "Feishu chat_id." },
            text: { type: "string", description: "Plain-text message body." },
          },
          required: ["chat_id", "text"],
        },
      },
      {
        name: "mcp__feishu__im_chat_read",
        description:
          "Fetch a chat's display name + type. Returns {name, chat_type}.",
        inputSchema: {
          type: "object",
          properties: { chat_id: { type: "string" } },
          required: ["chat_id"],
        },
      },
    ];
  }

  async invokeMcpTool(
    _scope: McpScope,
    _toolName: string,
    _input: unknown,
  ): Promise<McpToolResult> {
    // NOTE: provider-level mcpTools()/invokeMcpTool() are unused scaffolding —
    // no runtime path lists or invokes them (true across every provider:
    // Slack/GitHub/Linear/Feishu). The real Feishu tool-execution surface is
    // the in-process AI-SDK `tool()` map registered in
    // apps/main-node/src/lib/feishu-agent-tools.ts (mcp__feishu__im_message_send,
    // mcp__feishu__im_chat_read), merged into the harness tools from
    // buildHarnessContext. These descriptor/entry methods are kept only to
    // satisfy the IntegrationProvider contract.
    return {
      ok: false,
      error: {
        code: "not_implemented",
        message:
          "Feishu tool execution is in-process in apps/main-node/src/lib/feishu-agent-tools.ts, not the provider invokeMcpTool path.",
      },
    };
  }

  // ─── Internal: dispatch helper used by both the HTTP deferredWork path
  //     and the WS runner's onMessage handler. ────────────────────────────

  /**
   * Dispatch one normalized event into the harness.
   *
   * Returns the `{ sessionId }` the event was routed to (existing scope or a
   * freshly-created session), or `null` when the event wasn't a dispatchable
   * `im.message.receive_v1` (no chat / no scope_key). Callers — specifically
   * the WS runner's automatic-egress path — use the returned sessionId to
   * subscribe to that session's `agent.message` events and mirror the reply
   * back into Feishu.
   */
  async dispatchEvent(
    event: import("./webhook/parse").NormalizedFeishuEvent,
    pub: Publication,
  ): Promise<{ sessionId: string } | null> {
    if (event.kind !== "im.message.receive_v1" || !event.chatId) {
      return null;
    }
    const scopeKey = scopeKeyFor(event, pub.sessionGranularity);
    if (!scopeKey) {
      await this.container.webhookEvents.attachError(
        event.deliveryId,
        "no scope_key for granularity",
      );
      return null;
    }
    const existing =
      await this.container.feishuSessionScopes.getByScope(
        pub.id,
        scopeKey,
      );
    if (existing && existing.status === "active") {
      await this.container.sessions.resume(
        pub.userId,
        existing.sessionId,
        {
          type: "user.message",
          content: [
            {
              type: "text",
              text: renderFeishuSignal(event),
            },
          ],
          metadata: {
            provider: "feishu",
            chatId: event.chatId,
            chatType: event.chatType,
            messageId: event.deliveryId,
            senderOpenId: event.senderOpenId,
          },
        },
      );
      await this.container.webhookEvents.attachSession(
        event.deliveryId,
        existing.sessionId,
      );
      return { sessionId: existing.sessionId };
    }
    const sessionId = (await this.container.sessions.create({
      userId: pub.userId,
      agentId: pub.agentId,
      environmentId: pub.environmentId,
      vaultIds: [],
      mcpServers: [{ name: "feishu", url: "https://open.feishu.cn/mcp" }],
      metadata: {
        provider: "feishu",
        chatId: event.chatId,
        chatType: event.chatType,
        publicationId: pub.id,
      },
      initialEvent: {
        type: "user.message",
        content: [{ type: "text", text: renderFeishuSignal(event) }],
        metadata: {
          provider: "feishu",
          chatId: event.chatId,
          messageId: event.deliveryId,
          senderOpenId: event.senderOpenId,
        },
      },
      additionalSystemPrompt: FEISHU_SIGNAL_PROTOCOL_PROMPT,
    })).sessionId;
    await this.container.feishuSessionScopes.insert({
      tenantId: pub.tenantId,
      publicationId: pub.id,
      scopeKey,
      sessionId,
      status: "active",
      createdAt: this.container.clock.nowMs(),
    });
    await this.container.webhookEvents.attachSession(
      event.deliveryId,
      sessionId,
    );
    return { sessionId };
  }

  // ─── Internal helpers ──────────────────────────────────────────────────

  private async findPublicationByVerificationToken(
    token: string,
  ): Promise<Publication | null> {
    // Linear-style scan: walk all live publications, compare verification
    // tokens. The set is bounded (one publication per tenant per agent), so
    // this is cheap. The alternative — adding an encrypted-token index —
    // would require deterministic encryption (breaks the at-rest random IV).
    const pub = await this.container.publications.listPendingByUser("");
    void pub; // unused; we scan via dedicated method below
    // We can't list every tenant's publications from one query without a
    // tenantId. In practice the HTTP webhook is rarely used (WS is the
    // canonical path); return null on miss and let the WS path handle it.
    void token;
    return null;
  }
}

function renderFeishuSignal(
  event: import("./webhook/parse").NormalizedFeishuEvent,
): string {
  const attrs = {
    chat_id: event.chatId ?? "",
    chat_type: event.chatType ?? "",
    message_id: event.deliveryId,
    sender_open_id: event.senderOpenId ?? "",
    text: event.text ?? "",
  };
  return `<oma_signal kind="direct_invocation" ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeAttr(String(v))}"`)
    .join(" ")}></oma_signal>`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

// Exported for tests + the WS runner's onMessage handler.
export {
  FEISHU_SIGNAL_PROTOCOL_PROMPT,
  scopeKeyFor,
  detectSigningMode,
  computeEncryptKeyChallenge,
  computeVerificationTokenChallenge,
};

// Re-export DEFAULT_FEISHU_SCOPES + DEFAULT_FEISHU_SUBSCRIBED_EVENTS for
// the Console setup wizard.
export {
  DEFAULT_FEISHU_SCOPES,
  DEFAULT_FEISHU_SUBSCRIBED_EVENTS,
  ALL_FEISHU_CAPABILITIES,
};
// Suppress unused warning on FeishuApiClient — it's used by the WS runner
// when wiring the WSClient (the runner imports it directly from api/client).
void FeishuApiClient;
