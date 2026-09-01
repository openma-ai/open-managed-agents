import type { SessionResource } from "../domain/session-resource";
import type { SessionResourceInput } from "../domain/session-resource";
import type { SessionFileSourcePort } from "../session-resources/file-source";
import type { SessionMemoryStoreSourcePort } from "./memory-store-source";
import type {
  ResolveSessionResources,
  ResolveSessionResourcesResult,
  ResolvedSessionResourceSecret,
  SessionResourceResolverPort,
} from "./resource-resolver";

export interface SessionResourceResolverServiceDependencies {
  files: SessionFileSourcePort;
  memoryStores: SessionMemoryStoreSourcePort;
  ids: { nextResourceId(): string };
}

function validMountPath(value: string): boolean {
  return value.startsWith("/") && !value.split("/").includes("..");
}

function repositoryName(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const segment = url.pathname.split("/").filter(Boolean).at(-1);
    if (segment === undefined) return null;
    const name = decodeURIComponent(segment).replace(/\.git$/u, "");
    return name.length === 0 ? null : name;
  } catch {
    return null;
  }
}

function memoryMountName(name: string, memoryStoreId: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug.length === 0 ? memoryStoreId : slug;
}

export class SessionResourceResolverService
  implements SessionResourceResolverPort
{
  constructor(
    private readonly dependencies: SessionResourceResolverServiceDependencies,
  ) {}

  async resolve(
    input: ResolveSessionResources,
  ): Promise<ResolveSessionResourcesResult> {
    const resources: SessionResource[] = [];
    const secrets: ResolvedSessionResourceSecret[] = [];
    const mountPaths = new Set<string>();
    const memoryStoreIds = new Set<string>();

    for (const resource of input.resources) {
      const resolved = await this.resolveOne(input, resource);
      if (resolved.type !== "resolved") return resolved;
      if (
        resolved.resource.mountPath != null &&
        mountPaths.has(resolved.resource.mountPath)
      ) {
        return {
          type: "invalid_request",
          message: `Session resource mount path ${resolved.resource.mountPath} is already in use`,
        };
      }
      if (resolved.resource.type === "memory_store") {
        if (memoryStoreIds.has(resolved.resource.memoryStoreId)) {
          return {
            type: "invalid_request",
            message: `Memory store ${resolved.resource.memoryStoreId} is attached more than once`,
          };
        }
        memoryStoreIds.add(resolved.resource.memoryStoreId);
      }
      if (resolved.resource.mountPath != null) {
        mountPaths.add(resolved.resource.mountPath);
      }
      resources.push(resolved.resource);
      if (resolved.secret !== undefined) secrets.push(resolved.secret);
    }
    return { type: "resolved", resources, secrets };
  }

  private async resolveOne(
    context: ResolveSessionResources,
    input: SessionResourceInput,
  ): Promise<
    | {
        type: "resolved";
        resource: SessionResource;
        secret?: ResolvedSessionResourceSecret;
      }
    | Exclude<ResolveSessionResourcesResult, { type: "resolved" }>
  > {
    if (input.type === "file") {
      const file = await this.dependencies.files.find({
        workspaceId: context.workspaceId,
        fileId: input.fileId,
      });
      if (file === null) {
        return {
          type: "dependency_not_found",
          message: `File ${input.fileId} was not found`,
        };
      }
      const mountPath = input.mountPath ?? `/mnt/session/uploads/${input.fileId}`;
      if (!validMountPath(mountPath)) {
        return {
          type: "invalid_request",
          message: "Session resource mount path must be absolute and may not traverse parents",
        };
      }
      return {
        type: "resolved",
        resource: {
          id: this.dependencies.ids.nextResourceId(),
          type: "file",
          createdAt: context.createdAt,
          fileId: input.fileId,
          mountPath,
          updatedAt: context.createdAt,
        },
      };
    }

    if (input.type === "github_repository") {
      const name = repositoryName(input.url);
      if (name === null) {
        return {
          type: "invalid_request",
          message: "GitHub repository URL must be an HTTP(S) repository URL",
        };
      }
      if (input.authorizationToken.length === 0) {
        return {
          type: "invalid_request",
          message: "GitHub authorization token must not be empty",
        };
      }
      const mountPath = input.mountPath ?? `/workspace/${name}`;
      if (!validMountPath(mountPath)) {
        return {
          type: "invalid_request",
          message: "Session resource mount path must be absolute and may not traverse parents",
        };
      }
      const resourceId = this.dependencies.ids.nextResourceId();
      return {
        type: "resolved",
        resource: {
          id: resourceId,
          type: "github_repository",
          createdAt: context.createdAt,
          mountPath,
          updatedAt: context.createdAt,
          url: input.url,
          ...(input.checkout !== undefined && { checkout: input.checkout }),
        },
        secret: {
          type: "github_token",
          resourceId,
          authorizationToken: input.authorizationToken,
        },
      };
    }

    if (input.instructions !== undefined && input.instructions !== null) {
      if (input.instructions.length > 4096) {
        return {
          type: "invalid_request",
          message: "Memory store instructions must not exceed 4096 characters",
        };
      }
    }
    const memoryStore = await this.dependencies.memoryStores.find({
      workspaceId: context.workspaceId,
      memoryStoreId: input.memoryStoreId,
    });
    if (memoryStore === null || memoryStore.archivedAt !== null) {
      return {
        type: "dependency_not_found",
        message: `Memory store ${input.memoryStoreId} was not found`,
      };
    }
    return {
      type: "resolved",
      resource: {
        type: "memory_store",
        memoryStoreId: memoryStore.id,
        ...(input.access !== undefined && { access: input.access }),
        description: memoryStore.description ?? "",
        ...(input.instructions !== undefined && {
          instructions: input.instructions,
        }),
        mountPath: `/mnt/memory/${memoryMountName(memoryStore.name, memoryStore.id)}`,
        name: memoryStore.name,
      },
    };
  }
}
