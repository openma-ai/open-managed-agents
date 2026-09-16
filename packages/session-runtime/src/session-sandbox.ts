import { createNoEnvironmentSandbox, type SandboxPort } from "@open-managed-agents/sandbox";

export type SessionSandboxMode = "none" | "sandbox";

export interface SessionSandboxRuntimeDependencies {
  mode(): SessionSandboxMode | Promise<SessionSandboxMode>;
  create(): SandboxPort | Promise<SandboxPort>;
  prepare?(sandbox: SandboxPort): Promise<void>;
}

/** Owns sandbox selection and preparation for every session host. Platform
 * adapters supply physical operations; they never decide whether to run them. */
export class SessionSandboxRuntime {
  private allocation: Promise<SandboxPort> | null = null;
  private preparation: Promise<void> | null = null;
  private mode: SessionSandboxMode | null = null;

  constructor(private readonly dependencies: SessionSandboxRuntimeDependencies) {}

  get preparing(): Promise<void> | null { return this.preparation; }

  acquire(): Promise<SandboxPort> {
    return this.allocation ??= this.allocate().catch(error => {
      this.allocation = null;
      throw error;
    });
  }

  private async allocate(): Promise<SandboxPort> {
    this.mode = await this.dependencies.mode();
    return this.mode === "none" ? createNoEnvironmentSandbox() : this.dependencies.create();
  }

  prepare(): Promise<void> {
    return this.preparation ??= this.withSandbox(async sandbox => {
      await this.dependencies.prepare?.(sandbox);
    }).catch(error => {
      this.preparation = null;
      throw error;
    });
  }

  /** Physical workspace operations, including reconciliation, share the same
   * selection as allocation. A no-environment session never invokes them. */
  async withSandbox(operation: (sandbox: SandboxPort) => Promise<void>): Promise<void> {
    const sandbox = await this.acquire();
    if (this.mode === "sandbox") await operation(sandbox);
  }

  invalidatePreparation(): void { this.preparation = null; }
}
