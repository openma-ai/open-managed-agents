import type { McpOAuthApplicationPort, AuthorizeMcpOAuthCommand, AuthorizeMcpOAuthResult } from "../ports/mcp-oauth";
import type { McpOAuthStateCipher } from "./mcp-oauth";

/** Atomic operations; eventual-consistency KV get/delete cannot implement this port. */
export interface McpOAuthCliStore {
  create(id: string, value: string, expiresAtMs: number): Promise<void>;
  read(id: string): Promise<string | null>;
  compareAndSwap(id: string, expected: string, value: string): Promise<boolean>;
  consume(id: string, expected: string): Promise<boolean>;
}
export interface McpOAuthCliActor { workspaceId: string; userId: string | null; keyHash: string }
export interface McpOAuthCliSecrets { randomToken(): string; hash(value: string): Promise<string> }
interface Flow {
  actor: McpOAuthCliActor;
  claimHash: string;
  stateHash: string;
  innerState: string;
  callbackUri: string;
  expiresAtMs: number;
  status: "pending" | "completing" | "ready" | "failed";
  credentialId?: string;
}
export type McpOAuthCliStart = Omit<AuthorizeMcpOAuthCommand, "userId" | "returnTo"> & { actor: McpOAuthCliActor };
export type McpOAuthCliStartResult = Exclude<AuthorizeMcpOAuthResult, { type: "redirect" }> | { type: "started"; flowId: string; claimToken: string; authorizationUrl: string; expiresAt: string };
export type McpOAuthCliPollResult = { type: "pending" | "invalid_flow" | "failed" } | { type: "ready"; credentialId: string };
const TTL_MS = 10 * 60 * 1000;

/** CLI-only rendezvous. The provider keeps the service's registered callback.
 * Browser cookies never authorize this flow; only its sealed state can finish it.
 * Claiming additionally requires the original key, actor and a separate secret. */
export class McpOAuthCliService {
  constructor(private readonly deps: {
    store: McpOAuthCliStore;
    application(workspaceId: string): McpOAuthApplicationPort | Promise<McpOAuthApplicationPort>;
    cipher: McpOAuthStateCipher;
    secrets: McpOAuthCliSecrets;
    clock: { now(): Date };
  }) {}

  async start(command: McpOAuthCliStart): Promise<McpOAuthCliStartResult> {
    const app = await this.deps.application(command.actor.workspaceId);
    const result = await app.authorize({ ...command, userId: command.actor.userId, returnTo: new URL(command.callbackUri).origin });
    if (result.type !== "redirect") return result;
    const url = new URL(result.authorizationUrl);
    const innerState = url.searchParams.get("state");
    if (!innerState) throw new Error("OAuth state missing");
    const flowId = this.deps.secrets.randomToken();
    const claimToken = this.deps.secrets.randomToken();
    const expiresAtMs = this.deps.clock.now().getTime() + TTL_MS;
    const state = await this.deps.cipher.encrypt(JSON.stringify({ flow: "mcp_cli", id: flowId, nonce: this.deps.secrets.randomToken(), expiresAtMs }));
    const row: Flow = { actor: command.actor, claimHash: await this.deps.secrets.hash(claimToken), stateHash: await this.deps.secrets.hash(state), innerState, callbackUri: command.callbackUri, expiresAtMs, status: "pending" };
    await this.deps.store.create(flowId, JSON.stringify(row), expiresAtMs);
    url.searchParams.set("state", state);
    return { type: "started", flowId, claimToken, authorizationUrl: url.toString(), expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async callback(command: { state: string; code?: string; error?: string; callbackUri: string }): Promise<{ type: "completed" | "invalid_flow" } | null> {
    let sealed: { flow: string; id: string; expiresAtMs: number };
    try { sealed = JSON.parse(await this.deps.cipher.decrypt(command.state)); } catch { return null; }
    if (sealed?.flow !== "mcp_cli") return null;
    if (typeof sealed.id !== "string" || !Number.isFinite(sealed.expiresAtMs) || sealed.expiresAtMs <= this.deps.clock.now().getTime()) return { type: "invalid_flow" };
    const raw = await this.deps.store.read(sealed.id);
    if (raw === null) return { type: "invalid_flow" };
    const row = JSON.parse(raw) as Flow;
    if (row.status !== "pending" || row.expiresAtMs <= this.deps.clock.now().getTime() || row.callbackUri !== command.callbackUri || row.stateHash !== await this.deps.secrets.hash(command.state)) return { type: "invalid_flow" };
    const completing = JSON.stringify({ ...row, status: "completing" });
    if (!await this.deps.store.compareAndSwap(sealed.id, raw, completing)) return { type: "invalid_flow" };
    let terminal: Flow = { ...row, innerState: "", status: "failed" };
    try {
      if (!command.error && command.code) {
        const app = await this.deps.application(row.actor.workspaceId);
        const result = await app.complete({ state: row.innerState, code: command.code, callbackUri: row.callbackUri, userId: row.actor.userId });
        if (result.type === "connected") terminal = { ...terminal, status: "ready", credentialId: result.credentialId };
      }
    } catch { /* Only a fixed failed status is claimable. */ }
    await this.deps.store.compareAndSwap(sealed.id, completing, JSON.stringify(terminal));
    return { type: "completed" };
  }

  async poll(command: { actor: McpOAuthCliActor; flowId: string; claimToken: string }): Promise<McpOAuthCliPollResult> {
    const raw = await this.deps.store.read(command.flowId);
    if (raw === null) return { type: "invalid_flow" };
    const row = JSON.parse(raw) as Flow;
    const actor = command.actor;
    if (row.expiresAtMs <= this.deps.clock.now().getTime() || row.actor.workspaceId !== actor.workspaceId || row.actor.userId !== actor.userId || row.actor.keyHash !== actor.keyHash || row.claimHash !== await this.deps.secrets.hash(command.claimToken)) return { type: "invalid_flow" };
    if (row.status === "pending" || row.status === "completing") return { type: "pending" };
    if (!await this.deps.store.consume(command.flowId, raw)) return { type: "invalid_flow" };
    return row.status === "ready" && row.credentialId ? { type: "ready", credentialId: row.credentialId } : { type: "failed" };
  }
}
