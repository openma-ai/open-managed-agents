/**
 * Sandbox egress pass: the opaque value a sandbox presents to the egress
 * proxy (`Proxy-Authorization`) so the proxy knows whose Session a
 * connection belongs to. It names a workspace and Session and expires; it
 * is not a Vault credential and authorizes nothing but proxy attribution.
 *
 * Format: base64url(JSON claims) "." base64url(HMAC-SHA256(key, claims)).
 * The key is HKDF-derived from PLATFORM_ROOT_SECRET under a dedicated label,
 * so no other platform secret can mint or verify a pass.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const PASS_KEY_INFO = "openma.sandbox-egress.pass.v1";

export interface EgressPassClaims {
  workspaceId: string;
  sessionId: string;
  /** Expiry, epoch milliseconds. */
  expiresAt: number;
}

export type EgressPassVerification =
  | { type: "valid"; claims: EgressPassClaims }
  | { type: "invalid" }
  | { type: "expired"; claims: EgressPassClaims };

export interface EgressPassAuthority {
  issue(input: { workspaceId: string; sessionId: string; ttlMs: number }): string;
  verify(pass: string): EgressPassVerification;
}

export function createEgressPassAuthority(
  rootSecret: string,
  clock: { now(): Date },
): EgressPassAuthority {
  const key = Buffer.from(hkdfSync("sha256", rootSecret, Buffer.alloc(0), PASS_KEY_INFO, 32));
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest();
  return {
    issue({ workspaceId, sessionId, ttlMs }) {
      if (!workspaceId || !sessionId) throw new Error("egress pass requires a workspace and a Session");
      const claims: EgressPassClaims = {
        workspaceId,
        sessionId,
        expiresAt: clock.now().getTime() + ttlMs,
      };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${payload}.${Buffer.from(sign(payload)).toString("base64url")}`;
    },
    verify(pass) {
      const dot = pass.indexOf(".");
      if (dot <= 0 || dot !== pass.lastIndexOf(".")) return { type: "invalid" };
      const payload = pass.slice(0, dot);
      const presented = Buffer.from(pass.slice(dot + 1), "base64url");
      const expected = sign(payload);
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return { type: "invalid" };
      }
      let claims: EgressPassClaims;
      try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<EgressPassClaims>;
        if (
          typeof parsed.workspaceId !== "string" || parsed.workspaceId === ""
          || typeof parsed.sessionId !== "string" || parsed.sessionId === ""
          || typeof parsed.expiresAt !== "number"
        ) return { type: "invalid" };
        claims = { workspaceId: parsed.workspaceId, sessionId: parsed.sessionId, expiresAt: parsed.expiresAt };
      } catch {
        return { type: "invalid" };
      }
      if (claims.expiresAt <= clock.now().getTime()) return { type: "expired", claims };
      return { type: "valid", claims };
    },
  };
}

/**
 * The pass carried by a `Proxy-Authorization` header. Clients put the proxy
 * URL's userinfo there as `Basic base64(user:pass)`; the pass is the
 * password part.
 */
export function passFromProxyAuthorization(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Basic\s+(\S+)$/iu.exec(header.trim());
  if (match === null) return null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  // A pass is base64url plus ".", all URL-unreserved: clients send it as is.
  const pass = decoded.slice(colon + 1);
  return pass === "" ? null : pass;
}
