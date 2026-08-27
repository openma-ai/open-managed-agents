import type { App } from "@open-managed-agents/app";

export interface WorkspaceScope {
  workspaceId: string;
}

export type WorkspaceValue<Value> =
  | Value
  | ((scope: WorkspaceScope) => Value);

export function resolveWorkspaceValue<Value>(
  value: WorkspaceValue<Value>,
  scope: WorkspaceScope,
): Value {
  return typeof value === "function"
    ? (value as (scope: WorkspaceScope) => Value)(scope)
    : value;
}

export interface WorkspaceAppRegistryOptions<
  AppType extends App,
  Scope extends WorkspaceScope = WorkspaceScope,
> {
  createApp(scope: Scope): AppType;
}

/**
 * Platform-neutral registry for one application graph per workspace.
 *
 * The workspace key is mandatory and exact: platform adapters cannot fall
 * back to a process-global "current workspace" or share an app graph by
 * accident.
 */
export class WorkspaceAppRegistry<
  AppType extends App = App,
  Scope extends WorkspaceScope = WorkspaceScope,
> {
  private readonly apps = new Map<string, AppType>();

  constructor(
    private readonly options: WorkspaceAppRegistryOptions<AppType, Scope>,
  ) {}

  app(scope: Scope): AppType {
    assertWorkspaceId(scope.workspaceId);
    const current = this.apps.get(scope.workspaceId);
    if (current !== undefined) return current;
    const created = this.options.createApp(scope);
    this.apps.set(scope.workspaceId, created);
    return created;
  }

  existing(workspaceId: string): AppType | undefined {
    assertWorkspaceId(workspaceId);
    return this.apps.get(workspaceId);
  }

  async stop(workspaceId: string): Promise<boolean> {
    assertWorkspaceId(workspaceId);
    const app = this.apps.get(workspaceId);
    if (app === undefined) return false;
    this.apps.delete(workspaceId);
    await app.stop();
    return true;
  }

  async stopAll(): Promise<void> {
    const apps = [...this.apps.values()];
    this.apps.clear();
    await Promise.all(apps.map((app) => app.stop()));
  }
}

function assertWorkspaceId(workspaceId: string): void {
  if (workspaceId.trim().length === 0) {
    throw new TypeError("workspaceId must not be empty");
  }
}
