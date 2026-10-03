import type { AccessLossResource } from "./classify";

export interface AccessLossEffect {
  id: string;
  workspaceId: string;
  sessionId: string;
  serverName: string;
  provider: string;
  kind: "scope_lost" | "credential_lost";
  code: string;
  publicationId: string | null;
  resource: AccessLossResource | null;
  /** Execution generation captured when the proxy received the call. */
  generation: number;
  createdAt: string;
}

export type AccessLossEffectStatus = "recorded" | "applied" | "superseded";

export interface AccessLossEffectStore {
  record(effect: AccessLossEffect): Promise<
    | { type: "recorded" }
    | { type: "exists"; status: AccessLossEffectStatus }
  >;
  markApplied(id: string, appliedAt: string): Promise<boolean>;
  markSuperseded(id: string): Promise<void>;
}

export interface ScopeCloseResult {
  type: "closed" | "already_closed" | "not_found";
}

export interface AccessLossEffectPorts {
  maxGeneration(input: { workspaceId: string; sessionId: string }): Promise<number>;
  closeScope(input: {
    workspaceId: string;
    sessionId: string;
    provider: string;
  }): Promise<ScopeCloseResult>;
  cancelWakeups(input: { workspaceId: string; sessionId: string }): Promise<{ cancelled: number }>;
  stopExecution(input: {
    workspaceId: string;
    sessionId: string;
    generation: number;
    reason: string;
  }): Promise<void>;
  pauseCredential(effect: AccessLossEffect): Promise<void>;
  notify?(effect: AccessLossEffect): Promise<void>;
}

export type ApplyAccessLossResult =
  | { type: "applied"; scope: ScopeCloseResult | null; wakeupsCancelled: number }
  | { type: "already_applied" }
  | { type: "superseded" };

/**
 * One fenced, idempotent lifecycle transition.
 *
 * A delayed result is superseded when a newer execution generation exists,
 * so it cannot close a replacement session. Repeating the same effect does
 * not close, cancel, or notify a second time. Notification runs only after
 * the transition commits, and a notification failure leaves the commit in
 * place.
 */
export async function applyAccessLossEffect(
  effect: AccessLossEffect,
  store: AccessLossEffectStore,
  ports: AccessLossEffectPorts,
): Promise<ApplyAccessLossResult> {
  const recorded = await store.record(effect);
  if (recorded.type === "exists" && recorded.status === "applied") {
    return { type: "already_applied" };
  }
  if (recorded.type === "exists" && recorded.status === "superseded") {
    return { type: "superseded" };
  }

  if (await generationMoved(effect, ports)) {
    await store.markSuperseded(effect.id);
    return { type: "superseded" };
  }

  let scope: ScopeCloseResult | null = null;
  let wakeupsCancelled = 0;
  if (effect.kind === "scope_lost") {
    scope = await ports.closeScope({
      workspaceId: effect.workspaceId,
      sessionId: effect.sessionId,
      provider: effect.provider,
    });
    const wakeups = await ports.cancelWakeups({
      workspaceId: effect.workspaceId,
      sessionId: effect.sessionId,
    });
    wakeupsCancelled = wakeups.cancelled;
    await ports.stopExecution({
      workspaceId: effect.workspaceId,
      sessionId: effect.sessionId,
      generation: effect.generation,
      reason: `scope_lost:${effect.code}`,
    });
  } else {
    await ports.pauseCredential(effect);
  }

  const committed = await store.markApplied(effect.id, effect.createdAt);
  if (committed && ports.notify) {
    try {
      await ports.notify(effect);
    } catch {
      // The lifecycle row is already committed. Operators can retry
      // notification from that row; the session must stay closed.
    }
  }
  return { type: "applied", scope, wakeupsCancelled };
}

async function generationMoved(
  effect: AccessLossEffect,
  ports: AccessLossEffectPorts,
): Promise<boolean> {
  const current = await ports.maxGeneration({
    workspaceId: effect.workspaceId,
    sessionId: effect.sessionId,
  });
  return current > effect.generation;
}

export async function accessLossEffectId(effect: Omit<AccessLossEffect, "id" | "createdAt">): Promise<string> {
  const material = [
    effect.workspaceId,
    effect.sessionId,
    effect.serverName,
    effect.kind,
    effect.code,
    effect.resource?.type ?? "",
    effect.resource?.id ?? "",
    String(effect.generation),
  ].join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ale_${hex.slice(0, 32)}`;
}

export function publicationIdFromMetadata(metadata: unknown, provider: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const block = (metadata as Record<string, unknown>)[provider];
  if (!block || typeof block !== "object") return null;
  const publicationId = (block as Record<string, unknown>).publicationId;
  return typeof publicationId === "string" && publicationId.length > 0 ? publicationId : null;
}
