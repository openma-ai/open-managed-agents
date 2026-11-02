import { tool } from "ai";
import { z } from "zod";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { HttpClient } from "@open-managed-agents/integrations-core";
import { FeishuApiClient } from "@open-managed-agents/feishu";
import type { FeishuPublicationRepo } from "@open-managed-agents/feishu";

const toolInputMessageSend = z.object({
  chat_id: z.string().describe("Feishu chat_id (oc_…)."),
  text: z.string().describe("Plain-text message body."),
});
const toolInputChatRead = z.object({
  chat_id: z.string().describe("Feishu chat_id (oc_…)."),
});

// ──────────────────────────────────────────────────────────────────────────
// In-process Feishu tools for a Node self-host agent session.
//
// Why this exists (and why FeishuProvider.mcpTools()/invokeMcpTool() do not):
// The provider-level MCP-tool descriptors are unused scaffolding — no runtime
// path ever lists or invokes them (this is true for every provider: Slack,
// GitHub, Linear, Feishu). The real tool-execution surface the model sees is
// the AI-SDK `tool()` map passed to `streamText`, built per turn. For a
// Feishu-backed session this module registers two real tools —
// `mcp__feishu__im_message_send` and `mcp__feishu__im_chat_read` — that call
// `FeishuApiClient` directly. Tenant-access-token mint/caching/single-flight
// and 401-refresh all live inside `FeishuApiClient` (already unit-tested); the
// agent never sees the app secret.
//
// Wiring: configureFeishuAgentTools() is called once at boot (alongside the WS
// runner, which is the only ingest path that produces Feishu sessions); the
// registry's buildHarnessContext then calls resolveFeishuAgentTools(sessionId)
// per turn and merges the result into the base tool map. A non-Feishu session
// (or a missing/undecryptable publication) resolves to `{}` — a safe no-op
// spread.
// ──────────────────────────────────────────────────────────────────────────

/** Reads the persisted `sessions.metadata` JSON for a session id. */
export type SessionMetadataReader = (
  sessionId: string,
) => Promise<Record<string, unknown> | null>;

export interface FeishuAgentToolConfig {
  reader: SessionMetadataReader;
  pubs: FeishuPublicationRepo;
  http: HttpClient;
}

let config: FeishuAgentToolConfig | null = null;

/** One FeishuApiClient per App; the client caches its own access token. */
const clientCache = new Map<string, FeishuApiClient>();

/**
 * Wire the deps once at boot. Idempotent — re-calling replaces the config and
 * clears the client cache (used by tests between cases).
 */
export function configureFeishuAgentTools(next: FeishuAgentToolConfig): void {
  config = next;
  clientCache.clear();
}

/** Drop the config + client cache (test-only). */
export function resetFeishuAgentTools(): void {
  config = null;
  clientCache.clear();
}

/**
 * Build the two Feishu tools bound to a live client. Pure + exported so it is
 * unit-testable without a database — the only state it touches is the client's
 * own HTTP layer. Tool names mirror the `FeishuProvider.mcpTools()` descriptors
 * so system prompts referencing them stay accurate. The map is loosely typed
 * (`Record<string, any>`) to match the harness tool-map convention in
 * apps/agent/src/harness/tools.ts — the AI SDK's `tool()` default generic
 * parameters (`Tool<never, never>`) don't widen across two distinct schemas.
 */
export function buildFeishuTools(client: FeishuApiClient): Record<string, any> {
  return {
    mcp__feishu__im_message_send: tool({
      description:
        "Send a plain-text message into a Feishu chat. Returns the new message_id.",
      inputSchema: z.object({
        chat_id: z.string().describe("Feishu chat_id (oc_…)."),
        text: z.string().describe("Plain-text message body."),
      }),
      execute: async ({ chat_id, text }) => {
        try {
          const { messageId } = await client.sendText({ chatId: chat_id, text });
          return { ok: true as const, message_id: messageId };
        } catch (err) {
          // Surface a model-readable result rather than throwing — the agent
          // can react (retry, apologise) without a raw stack trace leaking.
          return { ok: false as const, error: errMsg(err) };
        }
      },
    }),
    mcp__feishu__im_chat_read: tool({
      description:
        "Fetch a Feishu chat's display name. Returns { name } (name is null when the chat is unknown or unreadable).",
      inputSchema: z.object({
        chat_id: z.string().describe("Feishu chat_id (oc_…)."),
      }),
      execute: async ({ chat_id }) => {
        try {
          const name = await client.getChatName(chat_id);
          return { ok: true as const, name };
        } catch (err) {
          return { ok: false as const, error: errMsg(err) };
        }
      },
    }),
  };
}

/**
 * Resolve the Feishu tools for a session, or `{}` when:
 *  - the integration isn't configured (e.g. WS runner disabled),
 *  - the session is not Feishu-backed,
 *  - the publication has no decryptable app secret.
 * Merging `{}` is a safe no-op, so callers always spread the result.
 */
export async function resolveFeishuAgentTools(
  sessionId: string,
): Promise<Record<string, any>> {
  if (!config) return {};
  const meta = await config.reader(sessionId);
  if (!meta || meta.provider !== "feishu") return {};
  const publicationId = meta.publicationId;
  if (typeof publicationId !== "string") return {};

  // The base Publication type carries no appId (Feishu-specific); resolve it
  // from the credential-state row that setCredentials() populates.
  const creds = await config.pubs.getCredentialState(publicationId);
  if (!creds?.appId) return {};

  const client = await resolveClient(creds.appId, publicationId, config);
  if (!client) return {};
  return buildFeishuTools(client);
}

async function resolveClient(
  appId: string,
  publicationId: string,
  deps: { pubs: FeishuPublicationRepo; http: HttpClient },
): Promise<FeishuApiClient | null> {
  const cached = clientCache.get(appId);
  if (cached) return cached;
  const appSecret = await deps.pubs.getAppSecret(publicationId);
  if (!appSecret) return null;
  const client = new FeishuApiClient({ appId, appSecret }, deps.http);
  clientCache.set(appId, client);
  return client;
}

/**
 * Default metadata reader backed by the shared `sessions` table. Mirrors the
 * query shape used by the node session router.
 */
export function sqlSessionMetadataReader(sql: SqlClient): SessionMetadataReader {
  return async (sessionId) => {
    const row = await sql
      .prepare("SELECT metadata FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ metadata: string | null }>();
    if (!row?.metadata) return null;
    try {
      return JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
