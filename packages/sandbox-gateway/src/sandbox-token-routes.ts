// What a sandbox token may reach, against the Session's resources as they are
// now (no snapshot in the token): the Session's MCP and model gateway routes,
// and the sandbox API for its skills, files and memory stores. Anything else
// (Work lifecycle, Session events, runtime-events, other Sessions) is refused.

import type { SandboxTokenSession } from "./sandbox-token-store";

export const SANDBOX_PROXY_PATH = /^\/v1\/oma\/(?:mcp-proxy|inference-proxy)\/([^/]+)(?:\/|$)/u;

function segments(path: string): string[] {
  return path.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return ""; }
  });
}

/** The Session id in an MCP / model gateway path, else null. */
export function proxySessionId(path: string): string | null {
  const raw = SANDBOX_PROXY_PATH.exec(path)?.[1];
  if (raw === undefined) return null;
  try { return decodeURIComponent(raw); } catch { return null; }
}

export function sandboxTokenAllows(session: SandboxTokenSession, method: string, path: string): boolean {
  const parts = segments(path);
  const verb = method.toUpperCase();
  if (parts[0] !== "v1") return false;
  if (parts[1] === "oma" && parts[2] === "mcp-proxy") {
    return parts.length === 5 && parts[3] === session.sessionId && parts[4]!.length > 0 && ["GET", "POST", "DELETE"].includes(verb);
  }
  if (parts[1] === "oma" && parts[2] === "inference-proxy") {
    return parts.length >= 5 && parts[3] === session.sessionId && parts[4]!.length > 0 && ["GET", "POST", "DELETE", "PATCH"].includes(verb);
  }
  if (parts[1] === "skills" && verb === "GET") {
    const skill = session.skills.find((candidate) => candidate.skillId === parts[2]);
    if (skill === undefined) return false;
    if (parts.length === 3 || (parts.length === 4 && parts[3] === "versions")) return true;
    return (parts.length === 5 || (parts.length === 6 && parts[5] === "content")) && parts[3] === "versions"
      && (parts[4] === skill.version || (skill.version === "latest" && /^\d+$/u.test(parts[4] ?? "")));
  }
  if (parts[1] === "files" && verb === "GET") {
    return session.fileIds.includes(parts[2] ?? "") && (parts.length === 3 || (parts.length === 4 && parts[3] === "content"));
  }
  if (parts[1] === "memory_stores") {
    const store = session.memoryStores.find((candidate) => candidate.memoryStoreId === parts[2]);
    if (store === undefined) return false;
    if (parts.length === 3) return verb === "GET";
    const write = store.access === "read_write" && (verb === "POST" || verb === "DELETE");
    if (parts[3] === "memories" && (parts.length === 4 || parts.length === 5)) return verb === "GET" || write;
    if (parts[3] === "memory_versions" && (parts.length === 4 || parts.length === 5)) return verb === "GET";
  }
  return false;
}
