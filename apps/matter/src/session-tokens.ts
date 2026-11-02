/**
 * Bearer tokens that identify an OpenMatter Agent Session to the Matter MCP
 * server. Each Session gets its own random token; OpenMA holds it in a vault
 * credential and attaches it to MCP requests from that session, so the MCP
 * server never trusts a session id chosen in a request.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentSessionInput } from "@openma/common/agent-contract";
import type { OmaClient } from "./oma-client.js";

export interface SessionTokenStore {
  /** Issue a new token for a Session. Only its hash is kept. */
  issue(sessionId: string): Promise<string>;
  /** The Session a token was issued for, or null. */
  resolve(token: string): Promise<string | null>;
}

const hash = (token: string): Buffer =>
  createHash("sha256").update(token, "utf8").digest();

/** In-process token store. A restart forgets every token, so a durable
 * host stores the hashes instead. */
export const createMemorySessionTokenStore = (): SessionTokenStore => {
  const sessions = new Map<string, { readonly digest: Buffer; readonly sessionId: string }>();
  return {
    issue: async (sessionId) => {
      const token = `omt_${randomBytes(32).toString("base64url")}`;
      const digest = hash(token);
      sessions.set(digest.toString("hex"), { digest, sessionId });
      return token;
    },
    resolve: async (token) => {
      if (token.length === 0) return null;
      const digest = hash(token);
      const entry = sessions.get(digest.toString("hex"));
      return entry !== undefined && timingSafeEqual(entry.digest, digest)
        ? entry.sessionId
        : null;
    },
  };
};

export interface SessionVaultOptions {
  readonly client: OmaClient;
  readonly tokens: SessionTokenStore;
  /** Public URL of the Matter MCP endpoint, as configured on the Agent.
   * OpenMA matches a vault credential to an MCP server by the URL's host. */
  readonly mcpServerUrl: string;
}

/**
 * `vaultIds` for `createOpenMAConnector`: before a new OpenMA session is
 * created, issue a token for the Session and put it in a vault of its own.
 */
export const sessionVaults =
  (options: SessionVaultOptions) =>
  async (input: AgentSessionInput): Promise<readonly string[]> => {
    const token = await options.tokens.issue(input.sessionId);
    const vault = await options.client.createVault(
      `openmatter:${input.sessionId}`,
    );
    await options.client.createBearerCredential({
      vaultId: vault.id,
      displayName: "OpenMatter tools",
      mcpServerUrl: options.mcpServerUrl,
      token,
    });
    return [vault.id];
  };
