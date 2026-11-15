import type { Env } from "@open-managed-agents/shared";

/** Cloudflare supplies object IO; the shared document store owns references. */
export function cfMemoryContent(bucket: Env["MEMORY_BUCKET"]) {
  const required = () => {
    if (!bucket) throw new Error("MEMORY_BUCKET is required for managed Memory contents");
    return bucket;
  };
  return {
    getText: async (key: string) => { const object = await required().get(key); return object === null ? null : object.text(); },
    put: (key: string, content: string) => required().put(key, content),
    delete: (key: string) => required().delete(key),
  };
}
