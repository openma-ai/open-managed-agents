// The forwarder's binding (gateway endpoint + this execution's sandbox token
// and the Session id it is sent with) lives in the relay's memory only.
//
// Delivery: the installer writes binding.<deliveryId>.next.json (0600) and
// mv's it to binding.json (atomic rename: a reader sees a whole file or none). The relay claims it by an atomic rename to a private name —
// never read-then-unlink, which could delete a newer delivery landing in
// between — parses and validates it, swaps it in as one object, and deletes
// the claimed file. A malformed delivery is deleted too (it may hold a token)
// and recorded as `error`; the working binding stays. Only the non-secret
// `deliveryId` is published (ready.json) so the installer can confirm it.
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface RelayBinding {
  endpoint: string;
  /** Sent as the Basic username (the token carries no Session data). */
  sessionId: string;
  token: string;
  ca?: string;
  directory: string;
  inspect?: boolean;
  /** Trust for direct upstreams instead of the public roots (fixtures only). */
  upstreamCa?: string;
}

export interface RelayBindingDelivery extends Omit<RelayBinding, "directory"> {
  /** Random, non-secret: echoed in ready.json once consumed. */
  deliveryId: string;
}

export function parseRelayBindingDelivery(text: string, directory: string): { binding: RelayBinding; deliveryId: string } {
  const parsed = JSON.parse(text) as Partial<RelayBindingDelivery>;
  const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";
  if (!nonEmpty(parsed.endpoint) || new URL(parsed.endpoint).protocol !== "https:") throw new Error("endpoint must be an https URL");
  if (!nonEmpty(parsed.sessionId) || parsed.sessionId.includes(":")) throw new Error("sessionId is invalid");
  if (!nonEmpty(parsed.token)) throw new Error("token is missing");
  if (!nonEmpty(parsed.deliveryId)) throw new Error("deliveryId is missing");
  const { deliveryId, ...binding } = parsed as RelayBindingDelivery;
  return { binding: { ...binding, directory }, deliveryId };
}

export interface RelayBindingState { deliveryId: string | null; error: string | null }

export interface RelayBindingHolder {
  /** Picks up a delivered binding.json, if any. Cheap when there is none. */
  consume(): void;
  /** The in-memory binding (after a consume); throws when there is none. */
  current(): RelayBinding;
  peek(): RelayBinding | null;
  state(): RelayBindingState;
  /** Stop consuming (the relay is exiting): a delivery stays on disk for the next relay. */
  freeze(): void;
}

export function createRelayBindingHolder(directory: string, onChange: (state: RelayBindingState) => void = () => undefined): RelayBindingHolder {
  const file = join(directory, "binding.json");
  const claimed = join(directory, `binding.consuming.${process.pid}`);
  let binding: RelayBinding | null = null;
  let state: RelayBindingState = { deliveryId: null, error: null };
  let frozen = false;
  const consume = () => {
    if (frozen || !existsSync(file)) return;
    try { renameSync(file, claimed); } catch { return; } // gone again: another consume won
    try {
      const next = parseRelayBindingDelivery(readFileSync(claimed, "utf8"), directory);
      binding = next.binding;
      state = { deliveryId: next.deliveryId, error: null };
    } catch (error) {
      state = { deliveryId: state.deliveryId, error: `binding rejected: ${error instanceof Error ? error.message : "unreadable"}` };
      process.stderr.write(`Sandbox credential relay: ${state.error}\n`);
    } finally {
      try { unlinkSync(claimed); } catch {}
    }
    onChange(state);
  };
  return {
    consume,
    current() { consume(); if (binding === null) throw new Error("Sandbox relay has no binding"); return binding; },
    peek: () => binding,
    state: () => state,
    freeze() { frozen = true; },
  };
}

/** HTTP Basic, the same pair a SOCKS5 user/password carries (sandbox-gateway
 * sandboxBasicCredential; duplicated: the relay bundle has no workspace deps). */
export const relayAuthorization = (binding: Pick<RelayBinding, "sessionId" | "token">) =>
  `Basic ${Buffer.from(`${binding.sessionId}:${binding.token}`).toString("base64")}`;
