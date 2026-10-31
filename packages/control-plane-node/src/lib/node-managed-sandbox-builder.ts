import {
  EMPTY_SANDBOX_IMAGE_CATALOG,
  resolveSandboxImage,
  type SandboxExecutor,
  type SandboxFactoryContext,
  type SandboxImageCatalog,
} from "@open-managed-agents/sandbox";
import type {
  Environment,
  Session,
} from "@open-managed-agents/managed-agents-application";
import type { PreparedSandboxBases } from "./prepared-sandbox-bases";
import type { SandboxFactoryCapabilities } from "@open-managed-agents/sandbox";
import { createHash } from "node:crypto";
import { join } from "node:path";

type SandboxScope = Pick<SandboxFactoryContext, "environmentId" | "workspaceId" | "image" | "preparedBase" | "allocationId">;

export interface ManagedSandboxBuilderDependencies {
  /** Operator SANDBOX_IMAGES catalog; empty when unset. */
  images?: SandboxImageCatalog;
  capabilities?: SandboxFactoryCapabilities;
  /** Per-session host workdir for a session id. */
  workdir(sessionId: string): string;
  /** The foundation's factory call: shared memory/outputs ctx plus scope. */
  build(sessionId: string, workdir: string, scope: SandboxScope): Promise<SandboxExecutor>;
  /** Prepared-base cache; absent leaves creation untouched. */
  preparedBases?: PreparedSandboxBases;
}

/**
 * The managed runner's `buildSandbox`: carries the owning workspace and
 * Environment into SandboxFactoryContext and resolves the Environment's
 * `_oma.sandbox_image` alias against the operator catalog. A selected alias
 * that the catalog no longer publishes fails the sandbox (and so the session
 * start) with SandboxImageUnavailableError; it never falls back to the
 * provider default image.
 */
export function createManagedSandboxBuilder(dependencies: ManagedSandboxBuilderDependencies) {
  const images = dependencies.images ?? EMPTY_SANDBOX_IMAGE_CATALOG;
  return async (input: {
    workspaceId: string;
    allocationId?: string;
    session: Pick<Session, "id"> & { agent?: Pick<Session["agent"], "openma"> };
    environment: Pick<Environment, "id" | "openma"> & { config?: Environment["config"] };
  }): Promise<SandboxExecutor> => {
    const image = resolveSandboxImage(
      images,
      input.environment.openma?.sandboxImage,
      input.environment.id,
    );
    if (input.allocationId !== undefined && dependencies.capabilities?.allocationIsolation !== true) {
      throw new Error("Managed checkpoint_restore requires a sandbox factory with allocation isolation");
    }
    const scope = {
      ...(input.allocationId === undefined ? {} : { allocationId: input.allocationId }),
      workspaceId: input.workspaceId,
      environmentId: input.environment.id,
      ...(image !== undefined && { image }),
    };
    const sessionWorkdir = dependencies.workdir(input.session.id);
    const workdir = input.allocationId === undefined ? sessionWorkdir : join(sessionWorkdir, "allocations",
      createHash("sha256").update(JSON.stringify([input.workspaceId, input.environment.id, input.session.id, input.allocationId])).digest("hex"));
    const build = (preparedBase?: SandboxFactoryContext["preparedBase"]) =>
      dependencies.build(input.session.id, workdir, preparedBase === undefined ? scope : { ...scope, preparedBase });
    const preparedBases = dependencies.preparedBases;
    if (preparedBases === undefined || input.environment.config === undefined) return build();
    const acp = input.session.agent?.openma?.harness === "acp-sandbox"
      ? input.session.agent.openma.acp?.agent.registry
      : undefined;
    return preparedBases.create(scope, {
      environment: {
        id: input.environment.id,
        config: input.environment.config,
        ...(input.environment.openma === undefined ? {} : { openma: input.environment.openma }),
      },
      ...(image !== undefined && { image }),
      ...(acp !== undefined && { acpRegistry: acp }),
    }, build);
  };
}
