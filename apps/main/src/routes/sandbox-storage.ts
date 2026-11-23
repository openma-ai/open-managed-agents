import { Hono } from "hono";
import type { Env, R2EventMessage } from "@open-managed-agents/shared";
import { fileR2Key, sessionOutputsPrefix } from "@open-managed-agents/shared";
import type { SandboxTokenSession } from "@open-managed-agents/sandbox-gateway";

type Variables = {
  tenant_id: string;
  sandbox_session?: SandboxTokenSession;
};

type StorageContext = { Bindings: Env; Variables: Variables };

type ResolvedObject = {
  bucket: R2Bucket;
  key: string;
  root: string;
  relative: string;
  readOnly: boolean;
  /** Direct legacy Memory Store objects are reflected into memory_versions by
   * the R2 event consumer. Workspace/snapshot objects are private staging
   * data and must not create canonical audit rows. */
  auditMemory: boolean;
};

const WORKSPACE_ROOT = ".openma-managed-memory-workspaces";
const SNAPSHOT_ROOT = ".openma-managed-memory-snapshots";

function decodeSegments(value: string): string[] | null {
  const result: string[] = [];
  for (const raw of value.split("/")) {
    if (raw === "") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\u0000")) {
      return null;
    }
    result.push(segment);
  }
  return result;
}

function relativeKey(root: string, relative: string): string {
  return relative === "" ? root : `${root}/${relative}`;
}

function rootMatchesWorkspace(parts: string[], tenantId: string, sessionId: string): boolean {
  return parts[0] === "t" && parts[1] === tenantId && parts[2] === "session-outputs" && parts[3] === sessionId;
}

function storeAccess(session: SandboxTokenSession, storeId: string): "read_only" | "read_write" | null {
  return session.memoryStores.find(store => store.memoryStoreId === storeId)?.access ?? null;
}

function resolveObject(
  kind: string,
  parts: string[],
  tenantId: string,
  sessionId: string,
  session: SandboxTokenSession,
  env: Env,
): ResolvedObject | null {
  if (kind === "outputs") {
    if (!env.FILES_BUCKET || parts.length < 4 || !rootMatchesWorkspace(parts, tenantId, sessionId)) return null;
    const root = sessionOutputsPrefix(tenantId, sessionId).replace(/\/$/u, "");
    const relative = parts.slice(4).join("/");
    return { bucket: env.FILES_BUCKET, key: relativeKey(root, relative), root, relative, readOnly: false, auditMemory: false };
  }

  if (kind === "inputs") {
    if (!env.FILES_BUCKET || parts.length !== 1 || !session.fileIds.includes(parts[0]!)) return null;
    const root = fileR2Key(tenantId, parts[0]!);
    return { bucket: env.FILES_BUCKET, key: root, root, relative: "", readOnly: true, auditMemory: false };
  }

  if (kind !== "memory" || !env.MEMORY_BUCKET) return null;

  // Session mounts use the canonical Memory Store prefix directly. Work
  // mounts use the immutable workspace/snapshot prefixes handled below.
  if (parts.length >= 1) {
    const access = storeAccess(session, parts[0]!);
    if (access !== null) {
      const root = parts[0]!;
      const relative = parts.slice(1).join("/");
      return { bucket: env.MEMORY_BUCKET, key: relativeKey(root, relative), root, relative, readOnly: access === "read_only", auditMemory: true };
    }
  }

  // Writable workspaces are generated as
  // .openma-managed-memory-workspaces/<tenant>/<session>/<generation>/<store>/data.
  if (parts.length >= 6 && parts[0] === WORKSPACE_ROOT && parts[1] === tenantId && parts[2] === sessionId && parts[5] === "data") {
    const access = storeAccess(session, parts[4]!);
    if (access !== "read_write") return null;
    const root = parts.slice(0, 6).join("/");
    const relative = parts.slice(6).join("/");
    return { bucket: env.MEMORY_BUCKET, key: relativeKey(root, relative), root, relative, readOnly: false, auditMemory: false };
  }

  // Read-only snapshots are content addressed and do not include a Session id.
  // The store allowlist and tenant prefix keep a token from selecting another
  // Session's store even though the snapshot itself is immutable.
  if (parts.length >= 4 && parts[0] === SNAPSHOT_ROOT && parts[1] === tenantId && /^[a-f0-9]{64}$/u.test(parts[3]!)) {
    const access = storeAccess(session, parts[2]!);
    if (access !== "read_only") return null;
    const root = parts.slice(0, 4).join("/");
    const relative = parts.slice(4).join("/");
    return { bucket: env.MEMORY_BUCKET, key: relativeKey(root, relative), root, relative, readOnly: true, auditMemory: false };
  }

  return null;
}

function responseHeaders(object: R2Object, contentType?: string): Headers {
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);
  headers.set("content-length", String(object.size));
  headers.set("x-oma-size", String(object.size));
  headers.set("x-oma-mod-time", object.customMetadata?.oma_mod_time ?? object.uploaded.toISOString());
  return headers;
}

async function listObjects(resolved: ResolvedObject, prefix: string): Promise<Response> {
  const safePrefix = decodeSegments(prefix);
  if (safePrefix === null) return Response.json({ error: "Unsafe prefix" }, { status: 400 });
  const relativePrefix = safePrefix.join("/");
  const base = relativeKey(resolved.root, relativePrefix);
  const list = await resolved.bucket.list({ prefix: base.endsWith("/") ? base : `${base}/`, delimiter: "/" });
  const prefixLength = relativePrefix === "" ? 0 : relativePrefix.length + 1;
  const relativeEntry = (key: string) => key.slice(`${resolved.root}/`.length + prefixLength).replace(/\/$/u, "");
  const entries = [
    ...list.delimitedPrefixes.map(key => ({ path: relativeEntry(key), is_dir: true, size: -1, mod_time: new Date(0).toISOString(), sha256: "" })),
    ...list.objects.map(object => ({ path: relativeEntry(object.key), is_dir: false, size: object.size, mod_time: object.customMetadata?.oma_mod_time ?? object.uploaded.toISOString(), sha256: "" })),
  ];
  return Response.json({ entries });
}

async function handleStorageRequest(c: import("hono").Context<StorageContext>): Promise<Response> {
  const session = c.get("sandbox_session");
  const tenantId = c.get("tenant_id");
  const sessionId = c.req.param("sessionId");
  if (!session || session.sessionId !== sessionId || session.workspaceId !== tenantId) return c.json({ error: "Sandbox session scope mismatch" }, 403);

  // Hono's wildcard matcher accepts `/*` but does not expose that suffix
  // through `c.req.param("*")` in every router implementation. Derive it
  // from the matched path after the fixed `/objects/` segment instead.
  const marker = "/objects/";
  const markerIndex = c.req.path.indexOf(marker);
  const wildcard = markerIndex < 0 ? "" : c.req.path.slice(markerIndex + marker.length);
  const parts = decodeSegments(wildcard);
  if (parts === null || parts.length < 2) return c.json({ error: "Invalid storage path" }, 400);

  // rclone's directory operations use a separate protocol path. They are
  // metadata-only for R2, which has no native directory entries.
  if (parts[0] === "directories") {
    if (parts.length < 3) return c.json({ error: "Invalid directory path" }, 400);
    const resolved = resolveObject(parts[1]!, parts.slice(2), tenantId, sessionId, session, c.env);
    if (!resolved || (c.req.method !== "POST" && c.req.method !== "DELETE") || resolved.readOnly) return c.json({ error: "Storage operation denied" }, 403);
    return new Response(null, { status: 204 });
  }

  const resolved = resolveObject(parts[0]!, parts.slice(1), tenantId, sessionId, session, c.env);
  if (!resolved) return c.json({ error: "Storage path denied" }, 403);
  const method = c.req.method;
  if (resolved.readOnly && ["PUT", "PATCH", "POST", "DELETE"].includes(method)) return c.json({ error: "Read-only storage" }, 403);
  if (method === "GET" && c.req.query("prefix") !== undefined) return listObjects(resolved, c.req.query("prefix") ?? "");

  if (method === "HEAD") {
    const object = await resolved.bucket.head(resolved.key);
    if (!object) return c.json({ error: "Not found" }, 404);
    return new Response(null, { status: 200, headers: responseHeaders(object) });
  }
  if (method === "GET") {
    const object = await resolved.bucket.get(resolved.key);
    if (!object) return c.json({ error: "Not found" }, 404);
    return new Response(object.body, { status: 200, headers: responseHeaders(object, object.httpMetadata?.contentType) });
  }
  if (method === "PUT") {
    const modTime = c.req.header("x-oma-mod-time");
    const customMetadata: Record<string, string> = {};
    if (modTime) customMetadata.oma_mod_time = modTime;
    if (resolved.auditMemory) {
      customMetadata.actor_type = "agent_session";
      customMetadata.actor_id = sessionId;
    }
    await resolved.bucket.put(resolved.key, c.req.raw.body, {
      httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" },
      ...(Object.keys(customMetadata).length > 0 ? { customMetadata } : {}),
    });
    await enqueueMemoryAuditEvent(c, resolved, resolved.key, "PutObject", sessionId);
    return new Response(null, { status: 204 });
  }
  if (method === "PATCH") {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Invalid metadata payload" }, 400);
    }
    const modTime = typeof payload === "object" && payload !== null && "mod_time" in payload
      ? (payload as { mod_time?: unknown }).mod_time
      : undefined;
    if (typeof modTime !== "string" || !Number.isFinite(Date.parse(modTime))) {
      return c.json({ error: "mod_time must be an RFC3339 timestamp" }, 400);
    }
    const object = await resolved.bucket.get(resolved.key);
    if (!object) return c.json({ error: "Not found" }, 404);
    // R2 metadata updates are implemented by rewriting the object while
    // preserving its bytes and HTTP metadata.
    await resolved.bucket.put(resolved.key, object.body, {
      httpMetadata: object.httpMetadata,
      customMetadata: {
        ...object.customMetadata,
        oma_mod_time: modTime,
        ...(resolved.auditMemory ? { actor_type: "agent_session", actor_id: sessionId } : {}),
      },
    });
    await enqueueMemoryAuditEvent(c, resolved, resolved.key, "PutObject", sessionId);
    return new Response(null, { status: 204 });
  }
  if (method === "DELETE") {
    // Queue the attributed event before R2 emits its metadata-free delete
    // notification, so the companion event wins the audit race.
    await enqueueMemoryAuditEvent(c, resolved, resolved.key, "DeleteObject", sessionId);
    await resolved.bucket.delete(resolved.key);
    return new Response(null, { status: 204 });
  }
  return c.json({ error: "Unsupported storage method" }, 405);
}

async function enqueueMemoryAuditEvent(
  c: import("hono").Context<StorageContext>,
  resolved: ResolvedObject,
  key: string,
  action: Extract<R2EventMessage["action"], "PutObject" | "DeleteObject">,
  sessionId: string,
): Promise<void> {
  if (!resolved.auditMemory || !c.env.MEMORY_QUEUE) return;
  const event: R2EventMessage = {
    account: "openma",
    action,
    bucket: "memory",
    object: { key },
    eventTime: new Date().toISOString(),
    actor: { type: "agent_session", id: sessionId },
  };
  await c.env.MEMORY_QUEUE.send(event);
}

export const sandboxStorageRoutes = new Hono<StorageContext>();
sandboxStorageRoutes.all("/sessions/:sessionId/objects/*", handleStorageRequest);
