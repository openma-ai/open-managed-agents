/** Repository revision mounted into a managed session. */
export type RepositoryCheckout =
  | { type: "branch"; name: string }
  | { type: "commit"; sha: string };

export type RepositoryCheckoutInput = RepositoryCheckout;

/**
 * Where a repository's clone credential comes from. Absent: the token given
 * when the resource was added (Claude Managed Agents). `bond`: the
 * workspace's Bond for the repository's host, resolved again each time a
 * sandbox is prepared; the Session stores no token (OMA extension).
 */
export type RepositoryCredentialSource = "bond";

export type SessionResourceInput =
  | {
      type: "file";
      fileId: string;
      mountPath?: string | null;
    }
  | {
      type: "github_repository";
      /** Omitted: clone with the workspace's Bond for the host (OMA extension). */
      authorizationToken?: string;
      url: string;
      checkout?: RepositoryCheckoutInput | null;
      mountPath?: string | null;
    }
  | {
      type: "memory_store";
      memoryStoreId: string;
      access?: "read_write" | "read_only" | null;
      instructions?: string | null;
    };

export type SessionResource =
  | {
      id: string;
      type: "file";
      createdAt: string;
      fileId: string;
      mountPath: string;
      updatedAt: string;
    }
  | {
      id: string;
      type: "github_repository";
      createdAt: string;
      mountPath: string;
      updatedAt: string;
      url: string;
      checkout?: RepositoryCheckout | null;
      credentialSource?: RepositoryCredentialSource;
    }
  | {
      type: "memory_store";
      memoryStoreId: string;
      access?: "read_write" | "read_only" | null;
      description?: string;
      instructions?: string | null;
      mountPath?: string | null;
      name?: string | null;
    };
