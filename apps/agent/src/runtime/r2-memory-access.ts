// SessionMemoryAccessPort for the Cloudflare agent's generic Memory sync
// (SANDBOX_ADAPTER=e2b without native storage).
//
// It reuses the agent's existing Memory Store mechanism instead of a second
// store: apps/main materializes each Session Memory Store into MEMORY_BUCKET
// under its runtime mount id (materializeManagedMemorySnapshot →
// runtimeMountStoreId), the sandbox works on `<storeId>/<path>` objects
// there (Cloudflare S3Mount and E2B s3fs mount the same prefix), and
// SessionDO.synchronizeManagedMemoryStores commits that prefix to canonical
// Memory with CAS at the turn barrier. This port reads and writes the same
// objects through the R2 binding, so the copy sync and the mounts converge on
// one store. Legacy `/v1/oma` stores use the store id as the prefix and the
// prefix is the bytes of truth, exactly as for their mounts.

import type { SessionMemoryAccessPort, SessionMemoryDocument } from "@open-managed-agents/runtime-resource-contract";

export type MemoryPrefixBucket = Pick<R2Bucket, "get" | "head" | "put" | "delete" | "list">;

/** Written by materializeManagedMemorySnapshot into a writable projection; not a Memory. */
const PROJECTION_MARKER = ".openma-memory-store";

export function createR2MemoryPrefixAccess(bucket: MemoryPrefixBucket): SessionMemoryAccessPort {
  const keyOf = (storeId: string, path: string) => {
    const relative = path.replace(/^\/+/u, "");
    if (relative === "" || relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`Unsafe Memory path: ${JSON.stringify(path)}`);
    }
    return `${prefixOf(storeId)}${relative}`;
  };
  const current = async (storeId: string, key: string) => {
    if (!key.startsWith(prefixOf(storeId))) return null;
    const object = await bucket.get(key);
    if (object === null) return null;
    const content = await object.text();
    return { etag: object.etag, content, sha256: await sha256(content) };
  };
  return {
    async list(input) {
      const prefix = prefixOf(input.memoryStoreId);
      const documents: SessionMemoryDocument[] = [];
      let cursor: string | undefined;
      do {
        input.signal.throwIfAborted();
        const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
        for (const object of page.objects) {
          // s3fs keeps directory placeholders as `dir/` objects.
          if (object.key.endsWith("/") || object.key.length === prefix.length || object.key === `${prefix}${PROJECTION_MARKER}`) continue;
          const body = await bucket.get(object.key);
          if (body === null) continue;
          const content = await body.text();
          documents.push({
            id: object.key,
            path: `/${object.key.slice(prefix.length)}`,
            contentSha256: await sha256(content),
            ...(input.projection === "full" ? { content } : {}),
          });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      return documents;
    },
    async create(input) {
      const key = keyOf(input.memoryStoreId, input.path);
      if (await bucket.head(key) !== null) return { type: "conflict" };
      await bucket.put(key, input.content);
      return { type: "applied" };
    },
    async update(input) {
      const existing = await current(input.memoryStoreId, input.memoryId);
      if (existing === null) return { type: "not_found" };
      if (existing.sha256 !== input.expectedContentSha256) return { type: "conflict" };
      const key = keyOf(input.memoryStoreId, input.path);
      if (key !== input.memoryId) {
        if (await bucket.head(key) !== null) return { type: "conflict" };
        await bucket.put(key, input.content);
        await bucket.delete(input.memoryId);
        return { type: "applied" };
      }
      const written = await bucket.put(key, input.content, { onlyIf: { etagMatches: existing.etag } });
      return written === null ? { type: "conflict" } : { type: "applied" };
    },
    async delete(input) {
      const existing = await current(input.memoryStoreId, input.memoryId);
      if (existing === null) return { type: "not_found" };
      if (existing.sha256 !== input.expectedContentSha256) return { type: "conflict" };
      await bucket.delete(input.memoryId);
      return { type: "applied" };
    },
  };
}

/** A store id is an object prefix: the store id itself for legacy stores,
 * or the nested runtime mount id of a writable Managed Memory workspace. */
function prefixOf(storeId: string): string {
  if (storeId.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe Memory Store id: ${JSON.stringify(storeId)}`);
  }
  return `${storeId}/`;
}

async function sha256(content: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
