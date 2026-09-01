import { describe, expect, it } from "vitest";
import { planV0Migration } from "../src/index";

describe("planV0Migration", () => {
  it("plans Session Resources as a projection of the Session aggregate", () => {
    const compat = planV0Migration({
      domains: [{ name: "session-resources", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });
    const native = planV0Migration({
      domains: [{ name: "session-resources", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(compat).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/compat-v0",
        "@open-managed-agents/session-resource-store",
        "@open-managed-agents/session-store",
      ],
      steps: [{
        domain: "session-resources",
        action: "install-compat-module",
        verify: [
          "SDK resource add, retrieve, list, update, and delete responses",
          "Session revision CAS and workspace isolation",
          "GitHub tokens are sealed and absent from public documents and logs",
          "Memory Store relation rows match the public resource snapshot",
          "mount-path validation and stable application cursors",
        ],
      }],
    });
    expect(native).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/session-resource-store",
        "@open-managed-agents/session-resource-store-sql",
        "@open-managed-agents/session-store",
        "@open-managed-agents/session-store-sql",
      ],
      steps: [{
        domain: "session-resources",
        action: "install-native-store",
        rollback: "Restore the v0 Session Resource composition; retain Session rows, resource links, and sealed secrets.",
      }],
    });
  });

  it("plans Session Thread aggregate and thread-event projection together", () => {
    const compat = planV0Migration({
      domains: [{ name: "session-threads", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });
    const native = planV0Migration({
      domains: [{ name: "session-threads", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(compat).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/compat-v0",
        "@open-managed-agents/session-event-store",
        "@open-managed-agents/session-thread-store",
      ],
      steps: [{
        domain: "session-threads",
        action: "install-compat-module",
        verify: [
          "SDK thread retrieve, list, archive, and thread-event list and stream responses",
          "workspace and Session isolation with stable cursors",
          "first archive transition and exactly-once lifecycle signaling",
          "thread-event relation and index match sessionThreadId",
          "existing Session event documents remain unchanged",
        ],
      }],
    });
    expect(native).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/session-event-store",
        "@open-managed-agents/session-event-store-sql",
        "@open-managed-agents/session-thread-store",
        "@open-managed-agents/session-thread-store-sql",
      ],
      steps: [{
        domain: "session-threads",
        action: "install-native-store",
        rollback: "Restore the v0 Session Thread composition; retain Thread rows and the shared Session event log.",
      }],
    });
  });

  it("produces an actionable, reversible dry-run plan", () => {
    const result = planV0Migration({
      domains: [
        { name: "agents", strategy: "compat" },
        { name: "sessions", strategy: "native" },
        { name: "session-events", strategy: "compat" },
      ],
      rollout: {
        type: "workspaces",
        workspaceIds: ["workspace_01", "workspace_02"],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.packages).toEqual([
      "@open-managed-agents/agent-store",
      "@open-managed-agents/compat-v0",
      "@open-managed-agents/session-event-store",
      "@open-managed-agents/session-store",
      "@open-managed-agents/session-store-sql",
    ]);
    expect(result.steps).toMatchObject([
      {
        domain: "agents",
        action: "install-compat-module",
        rollback: "Restore the v0 Agent composition for the same rollout scope.",
      },
      {
        domain: "sessions",
        action: "install-native-store",
        rollback: "Restore the v0 Session composition; keep additive v1 data intact.",
      },
      {
        domain: "session-events",
        action: "install-compat-module",
      },
    ]);
    expect(result.rollout).toEqual({
      type: "workspaces",
      workspaceIds: ["workspace_01", "workspace_02"],
    });
  });

  it("reports unsupported domains with a precise path and safe-to-ignore flag", () => {
    const result = planV0Migration({
      domains: [{ name: "webhooks", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.diagnostics).toEqual([{
      code: "domain_not_yet_supported",
      severity: "error",
      path: "domains[0].name",
      message: "webhooks has not been extracted into a v1 domain package yet",
      replacement: "Keep the v0 webhooks composition until its v1 Store packages are available.",
      safeToIgnore: false,
    }]);
  });

  it("plans SDK-shaped User Profile cutover without inventing tenant semantics", () => {
    const compat = planV0Migration({
      domains: [{ name: "user-profiles", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });
    const native = planV0Migration({
      domains: [{ name: "user-profiles", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(compat).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/compat-v0",
        "@open-managed-agents/user-profile-store",
      ],
      steps: [{
        domain: "user-profiles",
        action: "install-compat-module",
        verify: [
          "SDK create, retrieve, update, list, and enrollment URL responses",
          "metadata merge and deletion plus nullable field clearing",
          "ascending and descending cursor order binding",
          "ephemeral enrollment URLs are neither persisted nor logged",
          "provider-owned trust_grants remain read-only",
          "workspace isolation without domain-level tenant semantics",
        ],
      }],
    });
    expect(native).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/user-profile-store",
        "@open-managed-agents/user-profile-store-sql",
      ],
      steps: [{
        domain: "user-profiles",
        action: "install-native-store",
        rollback: "Restore the v0 User Profile composition; retain profiles, revisions, metadata, trust grants, and optional fields.",
      }],
    });
  });

  it("plans SDK-shaped Environment Work queue cutover", () => {
    const compat = planV0Migration({
      domains: [{ name: "environment-work", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });
    const native = planV0Migration({
      domains: [{ name: "environment-work", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(compat).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/compat-v0",
        "@open-managed-agents/environment-work-store",
      ],
      steps: [{
        domain: "environment-work",
        verify: [
          "SDK retrieve, update, list, ack, heartbeat, poll, stats, and stop responses",
          "metadata merge and deletion",
          "poll-only secret exposure and encryption at rest",
          "atomic claim and reclaim ordering",
          "heartbeat preconditions and revision CAS",
          "worker statistics and workspace isolation",
        ],
      }],
    });
    expect(native).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/environment-work-store",
        "@open-managed-agents/environment-work-store-sql",
      ],
      steps: [{
        domain: "environment-work",
        rollback: "Restore the v0 Environment Work composition; retain queue rows, encrypted credentials, claims, leases, revisions, and worker polling records.",
      }],
    });
  });

  it("plans SDK-shaped Tunnel and Certificate aggregate cutover", () => {
    const compat = planV0Migration({
      domains: [{ name: "tunnels", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });
    const native = planV0Migration({
      domains: [{ name: "tunnels", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(compat).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/compat-v0",
        "@open-managed-agents/tunnel-store",
      ],
      steps: [{
        domain: "tunnels",
        action: "install-compat-module",
        verify: [
          "SDK create, retrieve, list, archive, reveal-token, and rotate-token responses",
          "Tunnel and Certificate aggregate revision CAS",
          "two-active-certificate admission limit",
          "archive cascade and idempotency",
          "live token secrecy and rotation",
          "workspace isolation and stable cursors",
        ],
      }],
    });
    expect(native).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/tunnel-store",
        "@open-managed-agents/tunnel-store-sql",
      ],
      steps: [{
        domain: "tunnels",
        action: "install-native-store",
        rollback: "Restore the v0 Tunnel composition; retain Tunnel aggregates, revisions, hostnames, certificates, and token identifiers.",
      }],
    });
  });

  it("plans SDK-shaped Skill and Skill Version cutover with archive integrity", () => {
    const compat = planV0Migration({
      domains: [{ name: "skills", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });
    const native = planV0Migration({
      domains: [{ name: "skills", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(compat).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/compat-v0",
        "@open-managed-agents/skill-store",
      ],
      steps: [{
        domain: "skills",
        action: "install-compat-module",
        verify: [
          "SDK multipart Skill and Skill Version uploads",
          "Skill latest-version revision CAS",
          "source filters and stable cursors",
          "archive download bytes and headers",
          "Version deletion and predecessor promotion",
          "workspace isolation",
        ],
      }],
    });
    expect(native).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/skill-store",
        "@open-managed-agents/skill-store-sql",
      ],
      steps: [{
        domain: "skills",
        action: "install-native-store",
        rollback: "Restore the v0 Skill composition; retain Skill rows, Version rows, revisions, and archives.",
      }],
    });
  });

  it("plans SDK-shaped Memory document cutover with immutable history", () => {
    const compat = planV0Migration({
      domains: [{ name: "memories", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });
    const native = planV0Migration({
      domains: [{ name: "memories", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(compat).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/compat-v0",
        "@open-managed-agents/memory-document-store",
      ],
      steps: [{
        domain: "memories",
        action: "install-compat-module",
        verify: [
          "SDK memory and memory_prefix union responses",
          "basic and full content projections",
          "path uniqueness and content_sha256 preconditions",
          "atomic current-state and version history",
          "inclusive memory-version filters and redaction",
          "workspace isolation",
        ],
      }],
    });
    expect(native).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/memory-document-store",
        "@open-managed-agents/memory-document-store-sql",
      ],
      steps: [{
        domain: "memories",
        action: "install-native-store",
        rollback: "Restore the v0 Memory composition; retain current rows and immutable version history.",
      }],
    });
  });

  it("plans Memory Store cutover against the SDK-shaped v1 interface", () => {
    const compat = planV0Migration({
      domains: [{ name: "memory-stores", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });
    const native = planV0Migration({
      domains: [{ name: "memory-stores", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(compat).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/compat-v0",
        "@open-managed-agents/memory-store-store",
      ],
      steps: [{
        domain: "memory-stores",
        action: "install-compat-module",
        verify: [
          "SDK create, retrieve, update, list, archive, and delete responses",
          "inclusive created_at filters",
          "stable cursor ordering",
          "archive timestamps and revisions",
          "workspace isolation",
        ],
      }],
    });
    expect(native).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/memory-store-store",
        "@open-managed-agents/memory-store-store-sql",
      ],
      steps: [{
        domain: "memory-stores",
        action: "install-native-store",
        rollback: "Restore the v0 Memory Store composition; retain rows, revisions, metadata, and archive timestamps.",
      }],
    });
  });

  it("plans Dream cutover while preserving execution and optimistic concurrency", () => {
    const compat = planV0Migration({
      domains: [{ name: "dreams", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });
    const native = planV0Migration({
      domains: [{ name: "dreams", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(compat).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/compat-v0",
        "@open-managed-agents/dream-store",
      ],
      steps: [{
        domain: "dreams",
        action: "install-compat-module",
        verify: [
          "dream counts and lifecycle statuses",
          "revision conflicts",
          "scheduler rejection recording",
          "execution outputs and usage",
          "official API responses",
        ],
      }],
    });
    expect(native).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/dream-store",
        "@open-managed-agents/dream-store-sql",
      ],
      steps: [{
        domain: "dreams",
        action: "install-native-store",
        rollback: "Restore the v0 Dream composition; retain Dream rows, revisions, and execution outputs.",
      }],
    });
  });

  it("rejects duplicate domains and an empty workspace rollout", () => {
    const result = planV0Migration({
      domains: [
        { name: "agents", strategy: "compat" },
        { name: "agents", strategy: "native" },
      ],
      rollout: { type: "workspaces", workspaceIds: [] },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toMatchObject([
      { code: "duplicate_domain", path: "domains[1].name" },
      { code: "empty_rollout", path: "rollout.workspaceIds" },
    ]);
  });

  it("rejects ambiguous workspace rollout keys before routing", () => {
    const result = planV0Migration({
      domains: [{ name: "agents", strategy: "compat" }],
      rollout: {
        type: "workspaces",
        workspaceIds: ["workspace_01", "  ", "workspace_01"],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toMatchObject([
      { code: "invalid_workspace_id", path: "rollout.workspaceIds[1]" },
      { code: "duplicate_workspace", path: "rollout.workspaceIds[2]" },
    ]);
  });

  it("plans the Cloudflare wakeup facade without claiming a data migration", () => {
    const result = planV0Migration({
      domains: [{
        name: "session-wakeups",
        strategy: "compat",
        platform: "cloudflare",
      }],
      rollout: { type: "all" },
    });

    expect(result.ok).toBe(true);
    expect(result.packages).toEqual([
      "@open-managed-agents/session-wakeup",
      "@open-managed-agents/session-wakeup-cloudflare",
    ]);
    expect(result.steps).toEqual([{
      domain: "session-wakeups",
      action: "install-compat-module",
      packages: [
        "@open-managed-agents/session-wakeup",
        "@open-managed-agents/session-wakeup-cloudflare",
      ],
      verify: [
        "scheduled wakeup delivery",
        "terminated Session suppression",
        "20-item capacity",
        "legacy alarm row decoding",
      ],
      rollback: "Restore the v0 SessionDO wakeup methods; keep existing alarm rows intact.",
    }]);
  });

  it("adds a reversible workspace-scoped platform aggregation step", () => {
    const result = planV0Migration({
      platform: { kind: "node" },
      domains: [{ name: "agents", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });

    expect(result.ok).toBe(true);
    expect(result.packages).toEqual([
      "@open-managed-agents/agent-store",
      "@open-managed-agents/compat-v0",
      "@open-managed-agents/platform",
      "@open-managed-agents/platform-node",
    ]);
    expect(result.steps[0]).toEqual({
      domain: "platform",
      action: "install-platform-sdk",
      packages: [
        "@open-managed-agents/platform",
        "@open-managed-agents/platform-node",
      ],
      verify: [
        "workspace-scoped app identity",
        "cross-workspace Port isolation",
        "start/stop lifecycle",
      ],
      rollback: "Restore the v0 Node composition root; leave v1 domain packages installed.",
    });
  });

  it("plans an Environment compatibility-first cutover", () => {
    const result = planV0Migration({
      domains: [{ name: "environments", strategy: "compat" }],
      rollout: { type: "all" },
    });

    expect(result.ok).toBe(true);
    expect(result.packages).toEqual([
      "@open-managed-agents/compat-v0",
      "@open-managed-agents/environment-store",
    ]);
    expect(result.steps[0]).toMatchObject({
      domain: "environments",
      action: "install-compat-module",
      verify: [
        "environment counts",
        "revisions",
        "archive state",
        "official API responses",
      ],
    });
  });

  it("plans File metadata separately from File content storage", () => {
    const result = planV0Migration({
      domains: [{ name: "files", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });

    expect(result.ok).toBe(true);
    expect(result.packages).toEqual([
      "@open-managed-agents/compat-v0",
      "@open-managed-agents/file-content-store",
      "@open-managed-agents/file-store",
    ]);
    expect(result.steps[0]).toMatchObject({
      domain: "files",
      action: "install-compat-module",
      verify: [
        "file metadata counts",
        "directional pagination",
        "scope filters",
        "content download checksums",
        "official API responses",
      ],
    });
  });

  it("plans a compatibility-first Credential cutover without exposing secrets", () => {
    const result = planV0Migration({
      domains: [{ name: "credentials", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });

    expect(result.ok).toBe(true);
    expect(result.packages).toEqual([
      "@open-managed-agents/compat-v0",
      "@open-managed-agents/credential-store",
    ]);
    expect(result.steps[0]).toMatchObject({
      domain: "credentials",
      action: "install-compat-module",
      verify: [
        "credential counts by Vault",
        "redacted official API responses",
        "encrypted document round trips",
        "revision conflicts",
        "workspace and Vault isolation",
      ],
    });
  });

  it("plans Vault cutover while retaining rows, revisions, and Credential lookup", () => {
    const compat = planV0Migration({
      domains: [{ name: "vaults", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });
    const native = planV0Migration({
      domains: [{ name: "vaults", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(compat.ok).toBe(true);
    expect(compat.packages).toEqual([
      "@open-managed-agents/compat-v0",
      "@open-managed-agents/vault-store",
    ]);
    expect(compat.steps[0]).toMatchObject({
      domain: "vaults",
      action: "install-compat-module",
      verify: [
        "vault counts",
        "archived state",
        "revisions",
        "Credential lookup consistency",
        "official API responses",
      ],
    });
    expect(native).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/vault-store",
        "@open-managed-agents/vault-store-sql",
      ],
      steps: [{
        domain: "vaults",
        action: "install-native-store",
        rollback: "Restore the v0 Vault composition; retain existing rows and revisions.",
      }],
    });
  });

  it("plans Deployment cutover without rewriting retained core behavior or secrets", () => {
    const compat = planV0Migration({
      domains: [{ name: "deployments", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });
    const native = planV0Migration({
      domains: [{ name: "deployments", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(compat).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/compat-v0",
        "@open-managed-agents/deployment-store",
      ],
      steps: [{
        domain: "deployments",
        action: "install-compat-module",
        verify: [
          "deployment counts",
          "statuses and revisions",
          "sealed resource secret round trips",
          "dependency readiness",
          "official API responses",
        ],
        rollback: "Restore the v0 Deployment composition for the same rollout scope; retain rows, revisions, and sealed resource secrets.",
      }],
    });
    expect(native).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/deployment-store",
        "@open-managed-agents/deployment-store-sql",
      ],
      steps: [{
        domain: "deployments",
        action: "install-native-store",
        rollback: "Restore the v0 Deployment composition; retain rows, revisions, and sealed resource secrets.",
      }],
    });
  });

  it("plans Deployment Run cutover with atomic admission intact", () => {
    const compat = planV0Migration({
      domains: [{ name: "deployment-runs", strategy: "compat" }],
      rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
    });
    const native = planV0Migration({
      domains: [{ name: "deployment-runs", strategy: "native" }],
      rollout: { type: "all" },
    });

    expect(compat).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/compat-v0",
        "@open-managed-agents/deployment-run-store",
      ],
      steps: [{
        domain: "deployment-runs",
        action: "install-compat-module",
        verify: [
          "deployment run counts",
          "Deployment linkage",
          "session and error outcomes",
          "Run revision conflicts",
          "atomic active-Deployment admission",
          "official API responses",
        ],
      }],
    });
    expect(native).toMatchObject({
      ok: true,
      packages: [
        "@open-managed-agents/deployment-run-store",
        "@open-managed-agents/deployment-run-store-sql",
      ],
      steps: [{
        domain: "deployment-runs",
        action: "install-native-store",
        rollback: "Restore the v0 Deployment Run composition; retain Run rows, revisions, and Deployment linkage.",
      }],
    });
  });
});
