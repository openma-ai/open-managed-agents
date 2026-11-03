import { describe, expect, it } from "vitest";

const outboundPortSources = import.meta.glob(
  "../src/application/**/{persistence,*-persistence,*-source,*-issuer,*-descriptor,*-compiler,*-planner,*-launcher,*-scheduler,*-waiter,*-authority,*-manager,content-store,curator,enqueuer,memory-workspace,provisioner,resource-resolver,stream,lifecycle,events,threads,validation}.ts",
  {
    eager: true,
    import: "default",
    query: "?raw",
  },
) as Record<string, string>;

const deploymentStoreSources = import.meta.glob(
  "../src/storage/deployments.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const deploymentRunStoreSources = import.meta.glob(
  "../src/storage/deployment-runs.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const dreamStoreSources = import.meta.glob(
  "../src/storage/dreams.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const environmentWorkStoreSources = import.meta.glob(
  "../src/storage/environment-work.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const memoryStoreStoreSources = import.meta.glob(
  "../src/storage/memory-stores.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const memoryDocumentStoreSources = import.meta.glob(
  "../src/storage/memories.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const skillStoreSources = import.meta.glob(
  "../src/storage/skills.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const tunnelStoreSources = import.meta.glob(
  "../src/storage/tunnels.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const userProfileStoreSources = import.meta.glob(
  "../src/storage/user-profiles.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const sessionThreadStoreSources = import.meta.glob(
  "../src/storage/session-threads.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const sessionEventStoreSources = import.meta.glob(
  "../src/storage/session-events.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const sessionResourceStoreSources = import.meta.glob(
  "../src/storage/session-resources.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

describe("Managed Agents outbound port boundary", () => {
  it("is explicit, inner-owned, and independent of adapters and protocols", () => {
    expect(Object.keys(outboundPortSources).sort()).toEqual([
      "../src/application/credentials/persistence.ts",
      "../src/application/credentials/validation.ts",
      "../src/application/credentials/vault-source.ts",
      "../src/application/deployment-runs/persistence.ts",
      "../src/application/deployments/agent-source.ts",
      "../src/application/deployments/environment-source.ts",
      "../src/application/deployments/file-source.ts",
      "../src/application/deployments/memory-store-source.ts",
      "../src/application/deployments/persistence.ts",
      "../src/application/deployments/schedule-planner.ts",
      "../src/application/deployments/session-launcher.ts",
      "../src/application/deployments/vault-source.ts",
      "../src/application/dreams/curator.ts",
      "../src/application/dreams/execution-scheduler.ts",
      "../src/application/dreams/memory-store-source.ts",
      "../src/application/dreams/memory-workspace.ts",
      "../src/application/dreams/persistence.ts",
      "../src/application/dreams/session-source.ts",
      "../src/application/environment-work/availability-waiter.ts",
      "../src/application/environment-work/credential-issuer.ts",
      "../src/application/environment-work/enqueuer.ts",
      "../src/application/environment-work/environment-source.ts",
      "../src/application/environment-work/persistence.ts",
      "../src/application/environments/persistence.ts",
      "../src/application/files/content-store.ts",
      "../src/application/files/persistence.ts",
      "../src/application/memories/content-descriptor.ts",
      "../src/application/memories/memory-store-source.ts",
      "../src/application/memories/persistence.ts",
      "../src/application/memory-stores/persistence.ts",
      "../src/application/models/catalog-source.ts",
      "../src/application/session-events/session-source.ts",
      "../src/application/session-events/stream.ts",
      "../src/application/session-execution/context-source.ts",
      "../src/application/session-execution/events.ts",
      "../src/application/session-execution/history-source.ts",
      "../src/application/session-execution/lifecycle.ts",
      "../src/application/session-execution/projection-persistence.ts",
      "../src/application/session-execution/threads.ts",
      "../src/application/session-resources/file-source.ts",
      "../src/application/session-resources/persistence.ts",
      "../src/application/session-thread-events/persistence.ts",
      "../src/application/session-thread-events/stream.ts",
      "../src/application/session-thread-events/thread-source.ts",
      "../src/application/session-threads/persistence.ts",
      "../src/application/sessions/agent-source.ts",
      "../src/application/sessions/environment-source.ts",
      "../src/application/sessions/memory-store-source.ts",
      "../src/application/sessions/resource-resolver.ts",
      "../src/application/skills/package-compiler.ts",
      "../src/application/skills/persistence.ts",
      "../src/application/tunnels/certificate-authority.ts",
      "../src/application/tunnels/persistence.ts",
      "../src/application/tunnels/provisioner.ts",
      "../src/application/tunnels/token-manager.ts",
      "../src/application/user-profiles/enrollment-issuer.ts",
      "../src/application/user-profiles/persistence.ts",
      "../src/application/vaults/persistence.ts",
    ]);

    for (const source of Object.values(outboundPortSources)) {
      const externalImports = [...source.matchAll(/from ["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((specifier) => !specifier?.startsWith("."));
      expect(externalImports).toEqual([]);
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
    const store = dreamStoreSources["../src/storage/dreams.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("dream: Dream");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(outboundPortSources["../src/application/dreams/persistence.ts"])
      .toContain("DreamStore as DreamPersistencePort");
  });

  it("keeps Environment Work claims, secrets, leases, and CAS in one Store", () => {
    const store = environmentWorkStoreSources[
      "../src/storage/environment-work.ts"
    ];
    expect(store).toBeDefined();
    expect(store).toContain("record: EnvironmentWorkRecord");
    expect(store).toContain("secret: EnvironmentWorkSecret");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(store).toContain("claimAvailable(");
    expect(store).toContain("queueStats(");
    expect(outboundPortSources["../src/application/environment-work/persistence.ts"])
      .toContain("EnvironmentWorkStore as EnvironmentWorkPersistencePort");
  });

  it("keeps Memory Store persistence aggregate-based and CAS-explicit", () => {
    const store =
      memoryStoreStoreSources["../src/storage/memory-stores.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("memoryStore: MemoryStore");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(store).toContain("createdAtOrAfter?: string");
    expect(store).toContain("createdAtOrBefore?: string");
    expect(outboundPortSources["../src/application/memory-stores/persistence.ts"])
      .toContain("MemoryStoreStore as MemoryStorePersistencePort");
  });

  it("keeps Memory documents atomic, CAS-explicit, and history-preserving", () => {
    const store =
      memoryDocumentStoreSources["../src/storage/memories.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("memory: Memory");
    expect(store).toContain("version: MemoryVersion");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(store).toContain('type: "path_conflict"');
    expect(store).toContain("createdAtOrAfter?: string");
    expect(store).toContain("createdAtOrBefore?: string");
    expect(store).toContain("redactVersion(");
    expect(outboundPortSources["../src/application/memories/persistence.ts"])
      .toContain("MemoryDocumentStore as MemoryPersistencePort");
  });

  it("keeps Skills and immutable Version archives atomic and CAS-explicit", () => {
    const store = skillStoreSources["../src/storage/skills.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("skill: Skill");
    expect(store).toContain("version: SkillVersion");
    expect(store).toContain("archive: SkillPackageArchive");
    expect(store).toContain("insertWithInitialVersion(");
    expect(store).toContain("expectedSkillRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(store).toContain("findLatestVersionExcluding(");
    expect(outboundPortSources["../src/application/skills/persistence.ts"])
      .toContain("SkillStore as SkillPersistencePort");
  });

  it("keeps Tunnel archival and Certificates in one CAS aggregate", () => {
    const store = tunnelStoreSources["../src/storage/tunnels.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("aggregate: TunnelAggregate");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(outboundPortSources["../src/application/tunnels/persistence.ts"])
      .toContain("TunnelStore as TunnelPersistencePort");
    expect(outboundPortSources["../src/application/tunnels/provisioner.ts"])
      .toContain("TunnelProvisionerPort");
    expect(outboundPortSources["../src/application/tunnels/token-manager.ts"])
      .toContain("TunnelTokenManagerPort");
    expect(outboundPortSources["../src/application/tunnels/certificate-authority.ts"])
      .toContain("TunnelCertificateAuthorityPort");
  });

  it("keeps User Profiles scoped, CAS-explicit, and order-aware", () => {
    const store =
      userProfileStoreSources["../src/storage/user-profiles.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("profile: UserProfile");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain('type: "revision_conflict"');
    expect(store).toContain('order: "asc" | "desc"');
    expect(store).toContain("workspaceId: string");
    expect(outboundPortSources["../src/application/user-profiles/persistence.ts"])
      .toContain("UserProfileStore as UserProfilePersistencePort");
    expect(outboundPortSources["../src/application/user-profiles/enrollment-issuer.ts"])
      .toContain("UserProfileEnrollmentIssuerPort");
  });

  it("keeps Session Threads aggregate-scoped and Event reads on the event log", () => {
    const threadStore =
      sessionThreadStoreSources["../src/storage/session-threads.ts"];
    expect(threadStore).toBeDefined();
    expect(threadStore).toContain("thread: SessionThread");
    expect(threadStore).toContain("insert(input: InsertSessionThread)");
    expect(threadStore).toContain("transitioned: boolean");
    expect(outboundPortSources["../src/application/session-threads/persistence.ts"])
      .toContain("SessionThreadStore as SessionThreadPersistencePort");

    const eventStore =
      sessionEventStoreSources["../src/storage/session-events.ts"];
    expect(eventStore).toContain("interface SessionThreadEventStore");
    expect(eventStore).toContain("listThread(");
    expect(outboundPortSources["../src/application/session-thread-events/persistence.ts"])
      .toContain("SessionThreadEventStore as SessionThreadEventPersistencePort");
  });

  it("keeps Session Resources on the Session revision with atomic secret changes", () => {
    const store =
      sessionResourceStoreSources["../src/storage/session-resources.ts"];
    expect(store).toBeDefined();
    expect(store).toContain("resources: SessionResource[]");
    expect(store).toContain("expectedRevision: number");
    expect(store).toContain("secretChanges: SessionResourceSecretChange[]");
    expect(store).toContain('type: "revision_conflict"');
    expect(outboundPortSources["../src/application/session-resources/persistence.ts"])
      .toContain("SessionResourceStore as SessionResourcePersistencePort");
  });

  it("keeps Deployment dependencies aggregate-based and CAS-explicit", () => {
    const deploymentSources = Object.entries(outboundPortSources).filter(
      ([path]) => path.startsWith("../src/application/deployments/"),
    );
    expect(deploymentSources.map(([path]) => path).sort()).toEqual([
      "../src/application/deployments/agent-source.ts",
      "../src/application/deployments/environment-source.ts",
      "../src/application/deployments/file-source.ts",
      "../src/application/deployments/memory-store-source.ts",
      "../src/application/deployments/persistence.ts",
      "../src/application/deployments/schedule-planner.ts",
      "../src/application/deployments/session-launcher.ts",
      "../src/application/deployments/vault-source.ts",
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
      deploymentStoreSources["../src/storage/deployments.ts"];
    expect(persistence).toBeDefined();
    expect(persistence).toContain("expectedRevision: number");
    expect(persistence).toContain('type: "revision_conflict"');
    expect(persistence).toContain("deployment: Deployment");
    expect(persistence).toContain("resourceSecrets: DeploymentResourceSecret[]");
    expect(outboundPortSources["../src/application/deployments/persistence.ts"])
      .toContain("DeploymentStore as DeploymentPersistencePort");

    const runPersistence =
      deploymentRunStoreSources["../src/storage/deployment-runs.ts"];
    expect(runPersistence).toBeDefined();
    expect(runPersistence).toContain("expectedDeploymentRevision: number");
    expect(runPersistence).toContain('type: "deployment_revision_conflict"');
    expect(runPersistence).toContain("expectedRevision: number");
    expect(runPersistence).toContain('type: "revision_conflict"');
    expect(outboundPortSources["../src/application/deployment-runs/persistence.ts"])
      .toContain("DeploymentRunStore as DeploymentRunPersistencePort");
  });
});
