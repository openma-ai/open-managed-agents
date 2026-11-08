// Session resource records -> mount plan (design §0.7: Session inputs /
// resource mounting, one implementation for the Cloudflare SessionDO and the
// Node runner). Accepts both record spellings that reach a host: the domain
// camelCase Session resource (Node, CF Managed Session projection) and the
// legacy snake_case wire record (CF `/v1/oma`). Validation runs over the
// whole set before any side effect.

export type SessionResourceRecord = Readonly<Record<string, unknown>> & { readonly type: string };

export type RepositoryCheckout = { type: "branch"; name: string } | { type: "commit"; sha: string };

export interface FileMount {
  type: "file";
  fileId: string;
  mountPath: string;
}

export interface RepositoryMount {
  type: "github_repository";
  /** Session resource id; absent on legacy records. */
  id?: string;
  url: string;
  mountPath: string;
  checkout: RepositoryCheckout | null;
  /** `bond`: cloned with the workspace's Bond, refreshed on reuse (OMA extension). */
  credentialSource?: "bond";
}

export interface MemoryStoreMount {
  type: "memory_store";
  storeId: string;
  /** Snapshot prefix to mount instead of the store itself (runtime generation). */
  mountStoreId: string;
  /** Declared store name; null when it needs a metadata lookup. */
  name: string | null;
  mountPath: string | null;
  readOnly: boolean;
}

export interface EnvMount {
  type: "env";
  id: string;
  name: string;
}

export type SessionResourceMount = FileMount | RepositoryMount | MemoryStoreMount | EnvMount;

const DEFAULT_UPLOADS_ROOT = "/mnt/session/uploads";
const DEFAULT_REPOSITORY_PATH = "/workspace";

const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

function parseCheckout(raw: unknown): RepositoryCheckout | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const checkout = raw as { type?: unknown; name?: unknown; sha?: unknown };
  if (checkout.type === "branch") {
    const name = text(checkout.name) ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes("..") || name.endsWith("/") || name.endsWith(".")) {
      throw new Error("Session repository has an invalid Git branch");
    }
    return { type: "branch", name };
  }
  if (checkout.type === "commit") {
    const sha = text(checkout.sha) ?? "";
    if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) throw new Error("Session repository has an invalid Git commit SHA");
    return { type: "commit", sha };
  }
  if (checkout.type !== undefined) throw new Error("Session repository has an unsupported checkout type");
  return null;
}

/** Where a Memory Store resource mounts when its name is declared; null
 * when the name needs a metadata lookup. Used to plan mounts before a
 * Cloudflare container starts. */
export function memoryStoreMountTarget(
  record: Readonly<Record<string, unknown>>,
): { storeName: string; storeId: string; readOnly: boolean } | null {
  const storeId = text(record.memoryStoreId) ?? text(record.memory_store_id) ?? text(record.id);
  const mountStoreId = text(record.runtimeMountStoreId) ?? storeId;
  const name = text(record.name);
  if (name === undefined || name.length === 0 || mountStoreId === undefined) return null;
  return { storeName: name, storeId: mountStoreId, readOnly: record.access === "read_only" };
}

/** The mount plan for `records`, or the first validation error. */
export function planSessionResourceMounts(records: readonly SessionResourceRecord[]): SessionResourceMount[] {
  return records.map((record): SessionResourceMount => {
    switch (record.type) {
      case "file": {
        const fileId = text(record.fileId) ?? text(record.file_id) ?? "";
        if (fileId.trim().length === 0) throw new Error("Session file resource requires file_id");
        return {
          type: "file",
          fileId,
          mountPath: text(record.mountPath) ?? text(record.mount_path) ?? `${DEFAULT_UPLOADS_ROOT}/${fileId}`,
        };
      }
      case "github_repository":
      case "github_repo": {
        const url = text(record.url) ?? text(record.repo_url) ?? "";
        if (url.trim().length === 0) throw new Error("Session GitHub repository resource requires a URL");
        const id = text(record.id);
        return {
          type: "github_repository",
          ...(id === undefined ? {} : { id }),
          url,
          mountPath: text(record.mountPath) ?? text(record.mount_path) ?? DEFAULT_REPOSITORY_PATH,
          checkout: parseCheckout(record.checkout),
          ...(record.credentialSource === "bond" ? { credentialSource: "bond" as const } : {}),
        };
      }
      case "memory_store": {
        const storeId = text(record.memoryStoreId) ?? text(record.memory_store_id) ?? text(record.id);
        if (storeId === undefined) throw new Error("Session Memory Store resource requires memory_store_id");
        const name = text(record.name);
        return {
          type: "memory_store",
          storeId,
          mountStoreId: text(record.runtimeMountStoreId) ?? storeId,
          name: name === undefined || name.length === 0 ? null : name,
          mountPath: text(record.mountPath) ?? text(record.mount_path) ?? null,
          readOnly: record.access === "read_only",
        };
      }
      case "env":
      // env_secret: rows that predate the rename to env.
      case "env_secret": {
        const id = text(record.id) ?? "";
        const name = text(record.name) ?? "";
        if (id.length === 0 || name.length === 0) throw new Error("Session env resource requires its sealed secret value");
        return { type: "env", id, name };
      }
      default:
        throw new Error(`Unsupported Session resource type: ${String(record.type)}`);
    }
  });
}
