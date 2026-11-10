import type { BlobStore } from "@open-managed-agents/blob-store";
import type { SqlClient } from "@open-managed-agents/sql-client";

/** Per-invocation acknowledged allocations only. Never infer allocation from a
 * failed PUT, and never delete a candidate referenced after an ambiguous CAS. */
export function checkpointAllocations(blobs: BlobStore, sql: SqlClient, workspaceId: string, sessionId: string) {
  const prefix = `managed-session-workspace-checkpoints/${encodeURIComponent(workspaceId)}/${encodeURIComponent(sessionId)}/`;
  const allocated = new Set<string>();
  const store: BlobStore = {
    head:key=>blobs.head(key),get:key=>blobs.get(key),delete:key=>blobs.delete(key),
    put:async(key,body,options)=>{
      const result = await blobs.put(key,body,options);
      if (result && options?.precondition?.type === "ifNoneMatch" && key.startsWith(prefix)
        && /^wsc_[A-Za-z0-9-]+(?:\.state)?\.tar$/.test(key.slice(prefix.length))) allocated.add(key);
      return result;
    },
  };
  return {store, async discardUnreferenced() {
    // The candidate UUID is private to this invocation, so nobody can legally
    // publish it after our CAS has settled. Read ALL canonical references: a
    // malformed/unreadable row or failed deletion conservatively retains bytes.
    try {
      const rows = await sql.prepare("SELECT candidate_id,candidate_json FROM managed_session_workspace_checkpoints").all<{candidate_id:string|null;candidate_json:string|null}>();
      const referenced = new Set<string>();
      const ids = new Set<string>();
      for (const row of rows.results ?? []) {
        if (row.candidate_id) ids.add(row.candidate_id);
        if (row.candidate_json) {
          const candidate = JSON.parse(row.candidate_json);
          if (!candidate || typeof candidate.id !== "string" || !candidate.metadata) return;
          ids.add(candidate.id);
          for (const value of Object.values(candidate.metadata)) if (typeof value === "string") referenced.add(value);
        }
      }
      for (const key of allocated) {
        const id=key.slice(prefix.length).replace(/(?:\.state)?\.tar$/,"");
        if (!ids.has(id) && !referenced.has(key)) await blobs.delete(key);
      }
    } catch { /* Unknown reference/cleanup outcome is not proof of absence. */ }
  }};
}
