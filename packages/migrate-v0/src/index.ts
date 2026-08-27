export type V0MigrationStrategy = "compat" | "native";

export interface V0DomainMigration {
  name: string;
  strategy: V0MigrationStrategy;
  platform?: "cloudflare" | "node";
}

export type V0MigrationRollout =
  | { type: "all" }
  | { type: "workspaces"; workspaceIds: string[] };

export interface PlanV0MigrationInput {
  platform?: { kind: "cloudflare" | "node" };
  domains: V0DomainMigration[];
  rollout: V0MigrationRollout;
}

export interface V0MigrationDiagnostic {
  code:
    | "domain_not_yet_supported"
    | "duplicate_domain"
    | "duplicate_workspace"
    | "empty_rollout"
    | "invalid_workspace_id"
    | "platform_not_supported";
  severity: "error" | "warning";
  path: string;
  message: string;
  replacement?: string;
  safeToIgnore: boolean;
}

export interface V0MigrationStep {
  domain: string;
  action:
    | "install-compat-module"
    | "install-native-store"
    | "install-native-runtime"
    | "install-platform-sdk";
  packages: string[];
  verify: string[];
  rollback: string;
}

export interface V0MigrationPlan {
  ok: boolean;
  diagnostics: V0MigrationDiagnostic[];
  packages: string[];
  rollout: V0MigrationRollout;
  platform?: { kind: "cloudflare" | "node" };
  steps: V0MigrationStep[];
}

export interface V0MigrationWorkspaceScope {
  workspaceId: string;
}

export interface V0MigrationAppSource<
  AppType,
  Scope extends V0MigrationWorkspaceScope = V0MigrationWorkspaceScope,
> {
  app(scope: Scope): AppType;
}

export type V0MigrationLane = "v0" | "v1";

export type V0MigrationResolution<V0App, V1App> =
  | { lane: "v0"; app: V0App }
  | { lane: "v1"; app: V1App };

export interface CreateV0MigrationRouterOptions<
  V0App,
  V1App,
  Scope extends V0MigrationWorkspaceScope = V0MigrationWorkspaceScope,
> {
  plan: V0MigrationPlan;
  v0: V0MigrationAppSource<V0App, Scope>;
  v1: V0MigrationAppSource<V1App, Scope>;
}

export interface V0MigrationRouter<
  V0App,
  V1App,
  Scope extends V0MigrationWorkspaceScope = V0MigrationWorkspaceScope,
> {
  laneFor(workspaceId: string): V0MigrationLane;
  resolve(scope: Scope): V0MigrationResolution<V0App, V1App>;
  app(scope: Scope): V0App | V1App;
}

export class V0MigrationRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V0MigrationRouterError";
  }
}

interface SupportedDomain {
  label: string;
  interfacePackage: string;
  sharedPackages?: string[];
  nativeSharedPackages?: string[];
  nativePackage: string;
  compatPackage?: string;
  nativeAction?: V0MigrationStep["action"];
  platform?: V0DomainMigration["platform"];
  rollbackCompat: string;
  rollbackNative: string;
  verify: string[];
}

const supportedDomains: Record<string, SupportedDomain> = {
  agents: {
    label: "Agent",
    interfacePackage: "@open-managed-agents/agent-store",
    nativePackage: "@open-managed-agents/agent-store-sql",
    rollbackCompat: "Restore the v0 Agent composition for the same rollout scope.",
    rollbackNative: "Restore the v0 Agent composition; keep additive v1 data intact.",
    verify: ["agent counts", "current versions", "archived state", "official API responses"],
  },
  credentials: {
    label: "Credential",
    interfacePackage: "@open-managed-agents/credential-store",
    nativePackage: "@open-managed-agents/credential-store-sql",
    rollbackCompat: "Restore the v0 Credentials composition for the same rollout scope; retain sealed documents.",
    rollbackNative: "Restore the v0 Credentials composition; retain sealed documents and revisions.",
    verify: [
      "credential counts by Vault",
      "redacted official API responses",
      "encrypted document round trips",
      "revision conflicts",
      "workspace and Vault isolation",
    ],
  },
  deployments: {
    label: "Deployment",
    interfacePackage: "@open-managed-agents/deployment-store",
    nativePackage: "@open-managed-agents/deployment-store-sql",
    rollbackCompat: "Restore the v0 Deployment composition for the same rollout scope; retain rows, revisions, and sealed resource secrets.",
    rollbackNative: "Restore the v0 Deployment composition; retain rows, revisions, and sealed resource secrets.",
    verify: [
      "deployment counts",
      "statuses and revisions",
      "sealed resource secret round trips",
      "dependency readiness",
      "official API responses",
    ],
  },
  "deployment-runs": {
    label: "Deployment Run",
    interfacePackage: "@open-managed-agents/deployment-run-store",
    nativePackage: "@open-managed-agents/deployment-run-store-sql",
    rollbackCompat: "Restore the v0 Deployment Run composition for the same rollout scope; retain Run rows, revisions, and Deployment linkage.",
    rollbackNative: "Restore the v0 Deployment Run composition; retain Run rows, revisions, and Deployment linkage.",
    verify: [
      "deployment run counts",
      "Deployment linkage",
      "session and error outcomes",
      "Run revision conflicts",
      "atomic active-Deployment admission",
      "official API responses",
    ],
  },
  dreams: {
    label: "Dream",
    interfacePackage: "@open-managed-agents/dream-store",
    nativePackage: "@open-managed-agents/dream-store-sql",
    rollbackCompat: "Restore the v0 Dream composition for the same rollout scope; retain Dream rows, revisions, and execution outputs.",
    rollbackNative: "Restore the v0 Dream composition; retain Dream rows, revisions, and execution outputs.",
    verify: [
      "dream counts and lifecycle statuses",
      "revision conflicts",
      "scheduler rejection recording",
      "execution outputs and usage",
      "official API responses",
    ],
  },
  environments: {
    label: "Environment",
    interfacePackage: "@open-managed-agents/environment-store",
    nativePackage: "@open-managed-agents/environment-store-sql",
    rollbackCompat: "Restore the v0 Environment composition for the same rollout scope.",
    rollbackNative: "Restore the v0 Environment composition; keep additive v1 data intact.",
    verify: [
      "environment counts",
      "revisions",
      "archive state",
      "official API responses",
    ],
  },
  "environment-work": {
    label: "Environment Work",
    interfacePackage: "@open-managed-agents/environment-work-store",
    nativePackage: "@open-managed-agents/environment-work-store-sql",
    rollbackCompat: "Restore the v0 Environment Work composition for the same rollout scope; retain queue rows, encrypted credentials, claims, leases, revisions, and worker polling records.",
    rollbackNative: "Restore the v0 Environment Work composition; retain queue rows, encrypted credentials, claims, leases, revisions, and worker polling records.",
    verify: [
      "SDK retrieve, update, list, ack, heartbeat, poll, stats, and stop responses",
      "metadata merge and deletion",
      "poll-only secret exposure and encryption at rest",
      "atomic claim and reclaim ordering",
      "heartbeat preconditions and revision CAS",
      "worker statistics and workspace isolation",
    ],
  },
  files: {
    label: "File",
    interfacePackage: "@open-managed-agents/file-store",
    sharedPackages: ["@open-managed-agents/file-content-store"],
    nativePackage: "@open-managed-agents/file-store-sql",
    rollbackCompat: "Restore the v0 Files composition for the same rollout scope; retain existing metadata and content.",
    rollbackNative: "Restore the v0 Files composition; retain existing metadata and content.",
    verify: [
      "file metadata counts",
      "directional pagination",
      "scope filters",
      "content download checksums",
      "official API responses",
    ],
  },
  "memory-stores": {
    label: "Memory Store",
    interfacePackage: "@open-managed-agents/memory-store-store",
    nativePackage: "@open-managed-agents/memory-store-store-sql",
    rollbackCompat: "Restore the v0 Memory Store composition for the same rollout scope; retain rows, revisions, metadata, and archive timestamps.",
    rollbackNative: "Restore the v0 Memory Store composition; retain rows, revisions, metadata, and archive timestamps.",
    verify: [
      "SDK create, retrieve, update, list, archive, and delete responses",
      "inclusive created_at filters",
      "stable cursor ordering",
      "archive timestamps and revisions",
      "workspace isolation",
    ],
  },
  memories: {
    label: "Memory",
    interfacePackage: "@open-managed-agents/memory-document-store",
    nativePackage: "@open-managed-agents/memory-document-store-sql",
    rollbackCompat: "Restore the v0 Memory composition for the same rollout scope; retain current rows and immutable version history.",
    rollbackNative: "Restore the v0 Memory composition; retain current rows and immutable version history.",
    verify: [
      "SDK memory and memory_prefix union responses",
      "basic and full content projections",
      "path uniqueness and content_sha256 preconditions",
      "atomic current-state and version history",
      "inclusive memory-version filters and redaction",
      "workspace isolation",
    ],
  },
  skills: {
    label: "Skill",
    interfacePackage: "@open-managed-agents/skill-store",
    nativePackage: "@open-managed-agents/skill-store-sql",
    rollbackCompat: "Restore the v0 Skill composition for the same rollout scope; retain Skill rows, Version rows, revisions, and archives.",
    rollbackNative: "Restore the v0 Skill composition; retain Skill rows, Version rows, revisions, and archives.",
    verify: [
      "SDK multipart Skill and Skill Version uploads",
      "Skill latest-version revision CAS",
      "source filters and stable cursors",
      "archive download bytes and headers",
      "Version deletion and predecessor promotion",
      "workspace isolation",
    ],
  },
  tunnels: {
    label: "Tunnel",
    interfacePackage: "@open-managed-agents/tunnel-store",
    nativePackage: "@open-managed-agents/tunnel-store-sql",
    rollbackCompat: "Restore the v0 Tunnel composition for the same rollout scope; retain Tunnel aggregates, revisions, hostnames, certificates, and token identifiers.",
    rollbackNative: "Restore the v0 Tunnel composition; retain Tunnel aggregates, revisions, hostnames, certificates, and token identifiers.",
    verify: [
      "SDK create, retrieve, list, archive, reveal-token, and rotate-token responses",
      "Tunnel and Certificate aggregate revision CAS",
      "two-active-certificate admission limit",
      "archive cascade and idempotency",
      "live token secrecy and rotation",
      "workspace isolation and stable cursors",
    ],
  },
  "user-profiles": {
    label: "User Profile",
    interfacePackage: "@open-managed-agents/user-profile-store",
    nativePackage: "@open-managed-agents/user-profile-store-sql",
    rollbackCompat: "Restore the v0 User Profile composition for the same rollout scope; retain profiles, revisions, metadata, trust grants, and optional fields.",
    rollbackNative: "Restore the v0 User Profile composition; retain profiles, revisions, metadata, trust grants, and optional fields.",
    verify: [
      "SDK create, retrieve, update, list, and enrollment URL responses",
      "metadata merge and deletion plus nullable field clearing",
      "ascending and descending cursor order binding",
      "ephemeral enrollment URLs are neither persisted nor logged",
      "provider-owned trust_grants remain read-only",
      "workspace isolation without domain-level tenant semantics",
    ],
  },
  sessions: {
    label: "Session",
    interfacePackage: "@open-managed-agents/session-store",
    nativePackage: "@open-managed-agents/session-store-sql",
    rollbackCompat: "Restore the v0 Session composition for the same rollout scope.",
    rollbackNative: "Restore the v0 Session composition; keep additive v1 data intact.",
    verify: ["session counts", "revisions", "statuses", "resource links"],
  },
  "session-resources": {
    label: "Session Resource",
    interfacePackage: "@open-managed-agents/session-resource-store",
    sharedPackages: ["@open-managed-agents/session-store"],
    nativeSharedPackages: ["@open-managed-agents/session-store-sql"],
    nativePackage: "@open-managed-agents/session-resource-store-sql",
    rollbackCompat: "Restore the v0 Session Resource composition for the same rollout scope; retain Session rows, resource links, and sealed secrets.",
    rollbackNative: "Restore the v0 Session Resource composition; retain Session rows, resource links, and sealed secrets.",
    verify: [
      "SDK resource add, retrieve, list, update, and delete responses",
      "Session revision CAS and workspace isolation",
      "GitHub tokens are sealed and absent from public documents and logs",
      "Memory Store relation rows match the public resource snapshot",
      "mount-path validation and stable application cursors",
    ],
  },
  "session-events": {
    label: "Session Event",
    interfacePackage: "@open-managed-agents/session-event-store",
    nativePackage: "@open-managed-agents/session-event-store-sql",
    rollbackCompat: "Restore the v0 Session Event composition for the same rollout scope.",
    rollbackNative: "Restore the v0 Session Event composition; keep additive v1 data intact.",
    verify: ["event counts", "event ordering", "Session revisions", "side-effect receipts"],
  },
  "session-threads": {
    label: "Session Thread",
    interfacePackage: "@open-managed-agents/session-thread-store",
    sharedPackages: ["@open-managed-agents/session-event-store"],
    nativeSharedPackages: ["@open-managed-agents/session-event-store-sql"],
    nativePackage: "@open-managed-agents/session-thread-store-sql",
    rollbackCompat: "Restore the v0 Session Thread composition for the same rollout scope; retain Thread rows and the shared Session event log.",
    rollbackNative: "Restore the v0 Session Thread composition; retain Thread rows and the shared Session event log.",
    verify: [
      "SDK thread retrieve, list, archive, and thread-event list and stream responses",
      "workspace and Session isolation with stable cursors",
      "first archive transition and exactly-once lifecycle signaling",
      "thread-event relation and index match sessionThreadId",
      "existing Session event documents remain unchanged",
    ],
  },
  "session-wakeups": {
    label: "Session Wakeup",
    interfacePackage: "@open-managed-agents/session-wakeup",
    nativePackage: "@open-managed-agents/session-wakeup-cloudflare",
    compatPackage: "@open-managed-agents/session-wakeup-cloudflare",
    nativeAction: "install-native-runtime",
    platform: "cloudflare",
    rollbackCompat: "Restore the v0 SessionDO wakeup methods; keep existing alarm rows intact.",
    rollbackNative: "Restore the SessionDO compatibility facade; keep existing alarm rows intact.",
    verify: [
      "scheduled wakeup delivery",
      "terminated Session suppression",
      "20-item capacity",
      "legacy alarm row decoding",
    ],
  },
  vaults: {
    label: "Vault",
    interfacePackage: "@open-managed-agents/vault-store",
    nativePackage: "@open-managed-agents/vault-store-sql",
    rollbackCompat: "Restore the v0 Vault composition for the same rollout scope; retain existing rows and revisions.",
    rollbackNative: "Restore the v0 Vault composition; retain existing rows and revisions.",
    verify: [
      "vault counts",
      "archived state",
      "revisions",
      "Credential lookup consistency",
      "official API responses",
    ],
  },
};

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Builds a dry-run migration plan. The planner performs no I/O and mutates no
 * application, database, or routing state.
 */
export function planV0Migration(input: PlanV0MigrationInput): V0MigrationPlan {
  const diagnostics: V0MigrationDiagnostic[] = [];
  const candidateSteps: V0MigrationStep[] = [];
  const packages: string[] = [];
  const seen = new Set<string>();

  if (input.platform !== undefined) {
    const platformPackage = `@open-managed-agents/platform-${input.platform.kind}`;
    packages.push("@open-managed-agents/platform", platformPackage);
    candidateSteps.push({
      domain: "platform",
      action: "install-platform-sdk",
      packages: ["@open-managed-agents/platform", platformPackage],
      verify: [
        "workspace-scoped app identity",
        "cross-workspace Port isolation",
        "start/stop lifecycle",
      ],
      rollback: input.platform.kind === "node"
        ? "Restore the v0 Node composition root; leave v1 domain packages installed."
        : "Restore the v0 Cloudflare composition root; leave v1 domain packages installed.",
    });
  }

  input.domains.forEach((domain, index) => {
    if (seen.has(domain.name)) {
      diagnostics.push({
        code: "duplicate_domain",
        severity: "error",
        path: `domains[${index}].name`,
        message: `${domain.name} appears more than once in the migration plan`,
        replacement: "Declare each domain once with a single migration strategy.",
        safeToIgnore: false,
      });
      return;
    }
    seen.add(domain.name);

    const supported = supportedDomains[domain.name];
    if (supported === undefined) {
      diagnostics.push({
        code: "domain_not_yet_supported",
        severity: "error",
        path: `domains[${index}].name`,
        message: `${domain.name} has not been extracted into a v1 domain package yet`,
        replacement: `Keep the v0 ${domain.name} composition until its v1 Store packages are available.`,
        safeToIgnore: false,
      });
      return;
    }
    if (
      supported.platform !== undefined &&
      domain.platform !== supported.platform
    ) {
      diagnostics.push({
        code: "platform_not_supported",
        severity: "error",
        path: `domains[${index}].platform`,
        message: `${domain.name} currently supports the ${supported.platform} migration path only`,
        replacement: `Set platform to "${supported.platform}" or keep the current runtime implementation.`,
        safeToIgnore: false,
      });
      return;
    }

    const sharedPackages = supported.sharedPackages ?? [];
    packages.push(supported.interfacePackage, ...sharedPackages);
    if (domain.strategy === "compat") {
      const compatPackage = supported.compatPackage ??
        "@open-managed-agents/compat-v0";
      packages.push(compatPackage);
      candidateSteps.push({
        domain: domain.name,
        action: "install-compat-module",
        packages: [supported.interfacePackage, ...sharedPackages, compatPackage],
        verify: supported.verify,
        rollback: supported.rollbackCompat,
      });
      return;
    }
    const nativeSharedPackages = supported.nativeSharedPackages ?? [];
    packages.push(...nativeSharedPackages, supported.nativePackage);
    candidateSteps.push({
      domain: domain.name,
      action: supported.nativeAction ?? "install-native-store",
      packages: [
        supported.interfacePackage,
        ...sharedPackages,
        ...nativeSharedPackages,
        supported.nativePackage,
      ],
      verify: supported.verify,
      rollback: supported.rollbackNative,
    });
  });

  if (input.rollout.type === "workspaces" && input.rollout.workspaceIds.length === 0) {
    diagnostics.push({
      code: "empty_rollout",
      severity: "error",
      path: "rollout.workspaceIds",
      message: "A workspace rollout must select at least one workspace",
      replacement: "Add a workspace ID or use rollout.type = \"all\".",
      safeToIgnore: false,
    });
  }
  if (input.rollout.type === "workspaces") {
    const workspaces = new Set<string>();
    input.rollout.workspaceIds.forEach((workspaceId, index) => {
      if (workspaceId.length === 0 || workspaceId.trim() !== workspaceId) {
        diagnostics.push({
          code: "invalid_workspace_id",
          severity: "error",
          path: `rollout.workspaceIds[${index}]`,
          message: "Workspace rollout keys must be non-empty and may not have surrounding whitespace",
          replacement: "Use the exact workspace key accepted by the platform SDK.",
          safeToIgnore: false,
        });
        return;
      }
      if (workspaces.has(workspaceId)) {
        diagnostics.push({
          code: "duplicate_workspace",
          severity: "error",
          path: `rollout.workspaceIds[${index}]`,
          message: `${workspaceId} appears more than once in the rollout`,
          replacement: "Declare each workspace once.",
          safeToIgnore: false,
        });
        return;
      }
      workspaces.add(workspaceId);
    });
  }

  const ok = diagnostics.every((diagnostic) => diagnostic.severity !== "error");
  return {
    ok,
    diagnostics,
    packages: uniqueSorted(packages),
    rollout: structuredClone(input.rollout),
    ...(input.platform !== undefined && {
      platform: structuredClone(input.platform),
    }),
    steps: ok ? structuredClone(candidateSteps) : [],
  };
}

/**
 * Routes a workspace to an existing v0 or v1 application source using a
 * reviewed dry-run plan. Sources retain ownership of app caching/lifecycle;
 * this boundary only makes the cutover decision explicit and observable.
 */
export function createV0MigrationRouter<
  V0App,
  V1App,
  Scope extends V0MigrationWorkspaceScope = V0MigrationWorkspaceScope,
>(
  options: CreateV0MigrationRouterOptions<V0App, V1App, Scope>,
): V0MigrationRouter<V0App, V1App, Scope> {
  if (!options.plan.ok) {
    throw new V0MigrationRouterError(
      "Cannot route workspaces without a valid migration plan",
    );
  }
  const selected = options.plan.rollout.type === "workspaces"
    ? new Set(options.plan.rollout.workspaceIds)
    : null;
  if (selected?.has("") || [...selected ?? []].some((id) => id.trim().length === 0)) {
    throw new V0MigrationRouterError("Migration rollout workspaceId must not be empty");
  }
  const laneFor = (workspaceId: string): V0MigrationLane => {
    if (workspaceId.trim().length === 0) {
      throw new V0MigrationRouterError("workspaceId must not be empty");
    }
    return selected === null || selected.has(workspaceId) ? "v1" : "v0";
  };
  const resolve = (scope: Scope): V0MigrationResolution<V0App, V1App> => {
    const lane = laneFor(scope.workspaceId);
    return lane === "v1"
      ? { lane, app: options.v1.app(scope) }
      : { lane, app: options.v0.app(scope) };
  };
  return {
    laneFor,
    resolve,
    app(scope) {
      return resolve(scope).app;
    },
  };
}
