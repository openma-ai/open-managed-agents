import { describe, expect, it } from "vitest";

const outboundPortSources = import.meta.glob(
  "../src/**/{persistence,*-persistence,*-source,*-issuer,*-descriptor,*-compiler,*-planner,*-launcher,*-scheduler,*-waiter,*-authority,*-manager,content-store,curator,enqueuer,memory-workspace,provisioner,resource-resolver,stream,lifecycle,events,threads,validation}.ts",
  {
    eager: true,
    import: "default",
    query: "?raw",
  },
) as Record<string, string>;

const deploymentStoreSources = import.meta.glob(
  "../../deployment-store/src/index.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const deploymentRunStoreSources = import.meta.glob(
  "../../deployment-run-store/src/index.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const dreamStoreSources = import.meta.glob(
  "../../dream-store/src/index.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const environmentWorkStoreSources = import.meta.glob(
  "../../environment-work-store/src/index.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const memoryStoreStoreSources = import.meta.glob(
  "../../memory-store-store/src/index.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const memoryDocumentStoreSources = import.meta.glob(
  "../../memory-document-store/src/index.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const skillStoreSources = import.meta.glob(
  "../../skill-store/src/index.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const tunnelStoreSources = import.meta.glob(
  "../../tunnel-store/src/index.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const userProfileStoreSources = import.meta.glob(
  "../../user-profile-store/src/index.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const sessionThreadStoreSources = import.meta.glob(
  "../../session-thread-store/src/index.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const sessionEventStoreSources = import.meta.glob(
  "../../session-event-store/src/index.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const sessionResourceStoreSources = import.meta.glob(
  "../../session-resource-store/src/index.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

describe("Managed Agents outbound port boundary", () => {
  it("is explicit, inner-owned, and independent of adapters and protocols", () => {
    expect(Object.keys(outboundPortSources).sort()).toEqual([
      "../src/credentials/persistence.ts",
      "../src/credentials/validation.ts",
      "../src/credentials/vault-source.ts",
      "../src/deployment-runs/persistence.ts",
      "../src/deployments/agent-source.ts",
      "../src/deployments/environment-source.ts",
      "../src/deployments/file-source.ts",
      "../src/deployments/memory-store-source.ts",
      "../src/deployments/persistence.ts",
      "../src/deployments/schedule-planner.ts",
      "../src/deployments/session-launcher.ts",
      "../src/deployments/vault-source.ts",
      "../src/dreams/curator.ts",
      "../src/dreams/execution-scheduler.ts",
      "../src/dreams/memory-store-source.ts",
      "../src/dreams/memory-workspace.ts",
      "../src/dreams/persistence.ts",
      "../src/dreams/session-source.ts",
      "../src/environment-work/availability-waiter.ts",
      "../src/environment-work/credential-issuer.ts",
      "../src/environment-work/enqueuer.ts",
      "../src/environment-work/environment-source.ts",
      "../src/environment-work/persistence.ts",
      "../src/environments/persistence.ts",
      "../src/files/content-store.ts",
      "../src/files/persistence.ts",
      "../src/memories/content-descriptor.ts",
      "../src/memories/memory-store-source.ts",
      "../src/memories/persistence.ts",
      "../src/memory-stores/persistence.ts",
      "../src/models/catalog-source.ts",
      "../src/session-events/session-source.ts",
      "../src/session-events/stream.ts",
      "../src/session-execution/context-source.ts",
      "../src/session-execution/events.ts",
      "../src/session-execution/history-source.ts",
      "../src/session-execution/lifecycle.ts",
      "../src/session-execution/projection-persistence.ts",
      "../src/session-execution/threads.ts",
      "../src/session-resources/file-source.ts",
      "../src/session-resources/persistence.ts",
      "../src/session-thread-events/persistence.ts",
      "../src/session-thread-events/stream.ts",
      "../src/session-thread-events/thread-source.ts",
      "../src/session-threads/persistence.ts",
      "../src/sessions/agent-source.ts",
      "../src/sessions/environment-source.ts",
      "../src/sessions/memory-store-source.ts",
      "../src/sessions/resource-resolver.ts",
      "../src/skills/package-compiler.ts",
      "../src/skills/persistence.ts",
      "../src/tunnels/certificate-authority.ts",
      "../src/tunnels/persistence.ts",
      "../src/tunnels/provisioner.ts",
      "../src/tunnels/token-manager.ts",
      "../src/user-profiles/enrollment-issuer.ts",
      "../src/user-profiles/persistence.ts",
      "../src/vaults/persistence.ts",
    ]);

    for (const source of Object.values(outboundPortSources)) {
      const externalImports = [...source.matchAll(/from ["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((specifier) => !specifier?.startsWith("."));
      expect(externalImports.every((specifier) =>
        specifier === "@open-managed-agents/agent-store"
        || specifier === "@open-managed-agents/credential-store"
        || specifier === "@open-managed-agents/deployment-store"
        || specifier === "@open-managed-agents/deployment-run-store"
        || specifier === "@open-managed-agents/dream-store"
        || specifier === "@open-managed-agents/domain/skills"
        || specifier === "@open-managed-agents/domain/environment-work"
        || specifier === "@open-managed-agents/domain/tunnels"
        || specifier === "@open-managed-agents/domain/user-profiles"
        || specifier === "@open-managed-agents/environment-store"
        || specifier === "@open-managed-agents/environment-work-store"
        || specifier === "@open-managed-agents/file-content-store"
        || specifier === "@open-managed-agents/file-store"
        || specifier === "@open-managed-agents/memory-store-store"
        || specifier === "@open-managed-agents/memory-document-store"
        || specifier === "@open-managed-agents/session-event-store"
        || specifier === "@open-managed-agents/session-resource-store"
        || specifier.startsWith("@open-managed-agents/session-runtime")
        || specifier === "@open-managed-agents/session-store"
        || specifier === "@open-managed-agents/session-thread-store"
        || specifier === "@open-managed-agents/skill-store"
        || specifier === "@open-managed-agents/tunnel-store"
        || specifier === "@open-managed-agents/user-profile-store"
        || specifier === "@open-managed-agents/vault-store",
      )).toBe(true);
      expect(source).not.toMatch(/@open-managed-agents\/(?:managed-agents-api|db-schema)/);
      expect(source).not.toMatch(/@open-managed-agents\/memory-document-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/skill-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/tunnel-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/user-profile-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/environment-work-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/session-thread-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@open-managed-agents\/session-resource-store-(?:memory|sql)/);
      expect(source).not.toMatch(/@anthropic-ai\/sdk/);
      expect(source).not.toMatch(/from ["']\.\.\/ports\//);
      expect(source).not.toMatch(/from ["'](?:hono|zod|drizzle-orm)(?:\/[^"']*)?["']/);
      expect(source).not.toMatch(/\b(?:Drizzle|D1|Postgres|SQLite|SQL|SSE|HTTP)\b/);
      expect(source).not.toMatch(/(?:Http|http)[A-Z]/);
      expect(source).not.toMatch(/\b(?:any|unknown)\b/);
      expect(source).not.toMatch(/\bexists\s*\(/);
      expect(source).not.toMatch(/Promise<boolean>/);
      expect(source).not.toMatch(/:\s*object(?:\[\])?[;,)\n]/);
      expect(source).not.toMatch(/^\s*[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*\??\s*:/m);
    }
  });

  it("keeps Dream persistence aggregate-based and CAS-explicit", () => {
    const store = dreamStoreSources["../../dream-store/src/index.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("dream: Dream");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(outboundPortSources["../src/dreams/persistence.ts"])
      .toContain("DreamStore as DreamPersistencePort");
  });

  it("keeps Environment Work claims, secrets, leases, and CAS in one Store", () => {
    const store = environmentWorkStoreSources[
      "../../environment-work-store/src/index.ts"
    ];
    expect(store).toBeDefined();
    expect(store).toContain("record: EnvironmentWorkRecord");
    expect(store).toContain("secret: EnvironmentWorkSecret");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(store).toContain("claimAvailable(");
    expect(store).toContain("queueStats(");
    expect(outboundPortSources["../src/environment-work/persistence.ts"])
      .toContain("EnvironmentWorkStore as EnvironmentWorkPersistencePort");
  });

  it("keeps Memory Store persistence aggregate-based and CAS-explicit", () => {
    const store =
      memoryStoreStoreSources["../../memory-store-store/src/index.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("memoryStore: MemoryStore");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(store).toContain("createdAtOrAfter?: string");
    expect(store).toContain("createdAtOrBefore?: string");
    expect(outboundPortSources["../src/memory-stores/persistence.ts"])
      .toContain("MemoryStoreStore as MemoryStorePersistencePort");
  });

  it("keeps Memory documents atomic, CAS-explicit, and history-preserving", () => {
    const store =
      memoryDocumentStoreSources["../../memory-document-store/src/index.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("memory: Memory");
    expect(store).toContain("version: MemoryVersion");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(store).toContain('type: "path_conflict"');
    expect(store).toContain("createdAtOrAfter?: string");
    expect(store).toContain("createdAtOrBefore?: string");
    expect(store).toContain("redactVersion(");
    expect(outboundPortSources["../src/memories/persistence.ts"])
      .toContain("MemoryDocumentStore as MemoryPersistencePort");
  });

  it("keeps Skills and immutable Version archives atomic and CAS-explicit", () => {
    const store = skillStoreSources["../../skill-store/src/index.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("skill: Skill");
    expect(store).toContain("version: SkillVersion");
    expect(store).toContain("archive: SkillPackageArchive");
    expect(store).toContain("insertWithInitialVersion(");
    expect(store).toContain("expectedSkillRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(store).toContain("findLatestVersionExcluding(");
    expect(outboundPortSources["../src/skills/persistence.ts"])
      .toContain("SkillStore as SkillPersistencePort");
  });

  it("keeps Tunnel archival and Certificates in one CAS aggregate", () => {
    const store = tunnelStoreSources["../../tunnel-store/src/index.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("aggregate: TunnelAggregate");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(outboundPortSources["../src/tunnels/persistence.ts"])
      .toContain("TunnelStore as TunnelPersistencePort");
    expect(outboundPortSources["../src/tunnels/provisioner.ts"])
      .toContain("TunnelProvisionerPort");
    expect(outboundPortSources["../src/tunnels/token-manager.ts"])
      .toContain("TunnelTokenManagerPort");
    expect(outboundPortSources["../src/tunnels/certificate-authority.ts"])
      .toContain("TunnelCertificateAuthorityPort");
  });

  it("keeps User Profiles scoped, CAS-explicit, and order-aware", () => {
    const store =
      userProfileStoreSources["../../user-profile-store/src/index.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("profile: UserProfile");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(store).toContain('order: "asc" | "desc"');
    expect(store).toContain("workspaceId: string");
    expect(outboundPortSources["../src/user-profiles/persistence.ts"])
      .toContain("UserProfileStore as UserProfilePersistencePort");
    expect(outboundPortSources["../src/user-profiles/enrollment-issuer.ts"])
      .toContain("UserProfileEnrollmentIssuerPort");
  });

  it("keeps Session Threads aggregate-scoped and Event reads on the event log", () => {
    const threadStore =
      sessionThreadStoreSources["../../session-thread-store/src/index.ts"];
    expect(threadStore).toBeDefined();
    expect(threadStore).toContain("thread: SessionThread");
    expect(threadStore).toContain("insert(input: InsertSessionThread)");
    expect(threadStore).toContain("transitioned: boolean");
    expect(outboundPortSources["../src/session-threads/persistence.ts"])
      .toContain("SessionThreadStore as SessionThreadPersistencePort");

    const eventStore =
      sessionEventStoreSources["../../session-event-store/src/index.ts"];
    expect(eventStore).toContain("interface SessionThreadEventStore");
    expect(eventStore).toContain("listThread(");
    expect(outboundPortSources["../src/session-thread-events/persistence.ts"])
      .toContain("SessionThreadEventStore as SessionThreadEventPersistencePort");
  });

  it("keeps Session Resources on the Session revision with atomic secret changes", () => {
    const store =
      sessionResourceStoreSources["../../session-resource-store/src/index.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("resources: SessionResource[]");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain("secretChanges: SessionResourceSecretChange[]");
    expect(store).toContain('type: "revision_conflict"');
    expect(outboundPortSources["../src/session-resources/persistence.ts"])
      .toContain("SessionResourceStore as SessionResourcePersistencePort");
  });

  it("keeps Deployment dependencies aggregate-based and CAS-explicit", () => {
    const deploymentSources = Object.entries(outboundPortSources).filter(
      ([path]) => path.startsWith("../src/deployments/"),
    );
    expect(deploymentSources.map(([path]) => path).sort()).toEqual([
      "../src/deployments/agent-source.ts",
      "../src/deployments/environment-source.ts",
      "../src/deployments/file-source.ts",
      "../src/deployments/memory-store-source.ts",
      "../src/deployments/persistence.ts",
      "../src/deployments/schedule-planner.ts",
      "../src/deployments/session-launcher.ts",
      "../src/deployments/vault-source.ts",
    ]);
    for (const [, source] of deploymentSources) {
      expect(source).not.toMatch(/from ["']\.\.\/ports\//);
      expect(source).not.toMatch(/Promise<boolean>/);
    }
    for (const [path, source] of deploymentSources) {
      if (!path.endsWith("-source.ts")) continue;
      expect(source).toMatch(/Promise<[A-Z][A-Za-z0-9]* \| null>/);
    }
    const persistence =
      deploymentStoreSources["../../deployment-store/src/index.ts"];
    expect(persistence).toBeDefined();
    expect(persistence).toContain("expectedRevision: number");
    expect(persistence).toContain('type: "revision_conflict"');
    expect(persistence).toContain("deployment: Deployment");
    expect(persistence).toContain("resourceSecrets: DeploymentResourceSecret[]");
    expect(outboundPortSources["../src/deployments/persistence.ts"])
      .toContain("DeploymentStore as DeploymentPersistencePort");

    const runPersistence =
      deploymentRunStoreSources["../../deployment-run-store/src/index.ts"];
    expect(runPersistence).toBeDefined();
    expect(runPersistence).toContain("expectedDeploymentRevision: number");
    expect(runPersistence).toContain('type: "deployment_revision_conflict"');
    expect(runPersistence).toContain("expectedRevision: number");
    expect(runPersistence).toContain('type: "revision_conflict"');
    expect(outboundPortSources["../src/deployment-runs/persistence.ts"])
      .toContain("DeploymentRunStore as DeploymentRunPersistencePort");
  });
});
