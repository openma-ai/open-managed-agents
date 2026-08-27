import Anthropic from "@anthropic-ai/sdk";
import { exports } from "cloudflare:workers";
import { unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";

const SKILL_MARKDOWN = `---
name: repository-guide
description: How to work in this repository
---
# Repository guide
`;

const workerFetch: typeof fetch = async (input, init) => {
  const source =
    input instanceof Request
      ? input
      : new Request(input instanceof URL ? input.toString() : input, init);
  const url = new URL(source.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fetch(source);
  }
  return exports.default.fetch(
    new Request(`http://localhost${url.pathname}${url.search}`, source),
  );
};

beforeAll(async () => {
  await workerFetch("http://localhost/health");
});

describe("Cloudflare official Managed Agents route", () => {
  it("serves an exact official SDK create and retrieve shape", async () => {
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://localhost",
      fetch: workerFetch,
      maxRetries: 0,
    });

    const created = await client.beta.agents.create({
      name: "Cloudflare Managed Agent",
      model: "claude-opus-5",
      metadata: { owner: "platform" },
    });
    const retrieved = await client.beta.agents.retrieve(created.id);

    expect(created).toMatchObject({
      id: expect.stringMatching(/^agent_/),
      type: "agent",
      name: "Cloudflare Managed Agent",
      model: { id: "claude-opus-5" },
      metadata: { owner: "platform" },
      version: 1,
    });
    expect(Object.keys(created).sort()).toEqual([
      "archived_at",
      "created_at",
      "description",
      "id",
      "mcp_servers",
      "metadata",
      "model",
      "multiagent",
      "name",
      "skills",
      "system",
      "tools",
      "type",
      "updated_at",
      "version",
    ]);
    expect(retrieved).toEqual(created);

    const models = await client.beta.models.list({ limit: 1 });
    const retrievedModel = await client.beta.models.retrieve("claude-opus-5");
    expect(models.data).toEqual([retrievedModel]);
    expect(retrievedModel).toEqual({
      id: "claude-opus-5",
      allowed_fallback_models: null,
      capabilities: null,
      created_at: "1970-01-01T00:00:00.000Z",
      display_name: "Claude Opus 5",
      max_input_tokens: null,
      max_tokens: null,
      type: "model",
    });
    const omaModels = await workerFetch(
      "http://localhost/v1/oma/models/list",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
        },
        body: JSON.stringify({ provider: "unknown", api_key: "unused" }),
      },
    );
    expect(omaModels.status).toBe(200);
    expect(await omaModels.json()).toEqual({ data: [] });
    const omaModelsOnOfficialPath = await workerFetch(
      "http://localhost/v1/models/list",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
        },
        body: JSON.stringify({ provider: "ant", api_key: "unused" }),
      },
    );
    expect(omaModelsOnOfficialPath.status).toBe(404);

    const createdEnvironment = await client.beta.environments.create({
      name: "Cloudflare managed environment",
      description: "Cloudflare official environment",
      metadata: { owner: "platform" },
      scope: "organization",
      config: { type: "self_hosted" },
    });
    const retrievedEnvironment = await client.beta.environments.retrieve(
      createdEnvironment.id,
    );

    expect(createdEnvironment).toMatchObject({
      id: expect.stringMatching(/^env_/),
      type: "environment",
      name: "Cloudflare managed environment",
      description: "Cloudflare official environment",
      metadata: { owner: "platform" },
      scope: "organization",
      config: { type: "self_hosted" },
    });
    expect(retrievedEnvironment).toEqual(createdEnvironment);

    const uploadedFile = await client.beta.files.upload({
      file: new File(["hello from cf"], "notes.txt", {
        type: "text/plain",
      }),
    });
    const retrievedFile = await client.beta.files.retrieveMetadata(
      uploadedFile.id,
    );
    const downloadedFile = await client.beta.files.download(uploadedFile.id);

    expect(uploadedFile).toMatchObject({
      id: expect.stringMatching(/^file_/),
      type: "file",
      filename: "notes.txt",
      mime_type: "text/plain",
      size_bytes: 13,
      downloadable: true,
    });
    expect(retrievedFile).toEqual(uploadedFile);
    expect(await downloadedFile.text()).toBe("hello from cf");

    const createdMemoryStore = await client.beta.memoryStores.create({
      name: "Cloudflare project memory",
      description: "Cloudflare official memory store",
      metadata: { owner: "platform" },
    });
    const retrievedMemoryStore = await client.beta.memoryStores.retrieve(
      createdMemoryStore.id,
    );

    expect(createdMemoryStore).toMatchObject({
      id: expect.stringMatching(/^memstore_/),
      type: "memory_store",
      name: "Cloudflare project memory",
      description: "Cloudflare official memory store",
      metadata: { owner: "platform" },
      archived_at: null,
    });
    expect(retrievedMemoryStore).toEqual(createdMemoryStore);

    const createdMemory = await client.beta.memoryStores.memories.create(
      createdMemoryStore.id,
      {
        content: "hello from managed memory",
        path: "/notes/one.md",
        view: "full",
      },
    );
    const retrievedMemory = await client.beta.memoryStores.memories.retrieve(
      createdMemory.id,
      { memory_store_id: createdMemoryStore.id, view: "full" },
    );
    const retrievedMemoryVersion =
      await client.beta.memoryStores.memoryVersions.retrieve(
        createdMemory.memory_version_id,
        { memory_store_id: createdMemoryStore.id, view: "full" },
      );

    expect(createdMemory).toMatchObject({
      id: expect.stringMatching(/^mem_/),
      type: "memory",
      content: "hello from managed memory",
      content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      content_size_bytes: 25,
      memory_store_id: createdMemoryStore.id,
      memory_version_id: expect.stringMatching(/^memver_/),
      path: "/notes/one.md",
    });
    expect(retrievedMemory).toEqual(createdMemory);
    expect(retrievedMemoryVersion).toMatchObject({
      id: createdMemory.memory_version_id,
      type: "memory_version",
      content: "hello from managed memory",
      memory_id: createdMemory.id,
      memory_store_id: createdMemoryStore.id,
      operation: "created",
      path: createdMemory.path,
    });

    const createdDream = await client.beta.dreams.create({
      inputs: [
        { type: "memory_store", memory_store_id: createdMemoryStore.id },
      ],
      model: "claude-opus-5",
      instructions: "Keep durable project decisions",
    });
    expect(createdDream).toMatchObject({
      id: expect.stringMatching(/^dream_/),
      type: "dream",
      status: "pending",
      error: null,
      inputs: [
        { type: "memory_store", memory_store_id: createdMemoryStore.id },
      ],
      model: { id: "claude-opus-5" },
      output_behavior: { type: "create_new" },
      outputs: [],
    });
    const completedDream = await waitForTerminalDream(
      () => client.beta.dreams.retrieve(createdDream.id),
    );
    expect(completedDream).toMatchObject({
      id: createdDream.id,
      status: "completed",
      error: null,
      ended_at: expect.any(String),
      outputs: [
        {
          type: "memory_store",
          memory_store_id: expect.stringMatching(/^memstore_/),
        },
      ],
    });
    const outputMemoryStoreId = completedDream.outputs[0]!.memory_store_id;
    const outputMemories = await client.beta.memoryStores.memories.list(
      outputMemoryStoreId,
      { view: "full" },
    );
    expect(outputMemories.data).toMatchObject([
      { path: "/notes/one.md", content: "hello from managed memory" },
    ]);
    const dreamsPage = await client.beta.dreams.list({ statuses: ["completed"] });
    expect(dreamsPage.data).toEqual([completedDream]);
    const archivedDream = await client.beta.dreams.archive(createdDream.id);
    expect(archivedDream).toMatchObject({
      id: createdDream.id,
      archived_at: expect.any(String),
      status: "completed",
    });

    const createdSkill = await client.beta.skills.create({
      display_title: "Repository guide",
      files: [
        new File([SKILL_MARKDOWN], "repository-guide/SKILL.md", {
          type: "text/markdown",
        }),
        new File(["reference"], "repository-guide/reference.txt", {
          type: "text/plain",
        }),
      ],
    });
    const retrievedSkill = await client.beta.skills.retrieve(createdSkill.id);
    const initialSkillVersion = await client.beta.skills.versions.retrieve(
      createdSkill.latest_version!,
      { skill_id: createdSkill.id },
    );
    const downloadedSkillVersion = await client.beta.skills.versions.download(
      createdSkill.latest_version!,
      { skill_id: createdSkill.id },
    );

    expect(createdSkill).toMatchObject({
      id: expect.stringMatching(/^skill_/),
      type: "skill",
      display_title: "Repository guide",
      latest_version: expect.any(String),
      source: "custom",
    });
    expect(retrievedSkill).toEqual(createdSkill);
    expect(initialSkillVersion).toMatchObject({
      id: expect.stringMatching(/^skv_/),
      type: "skill_version",
      description: "How to work in this repository",
      directory: "repository-guide",
      name: "repository-guide",
      skill_id: createdSkill.id,
      version: createdSkill.latest_version,
    });
    expect(
      Object.keys(
        unzipSync(new Uint8Array(await downloadedSkillVersion.arrayBuffer())),
      ).sort(),
    ).toEqual([
      "repository-guide/SKILL.md",
      "repository-guide/reference.txt",
    ]);

    const createdVault = await client.beta.vaults.create({
      display_name: "Cloudflare production credentials",
      metadata: { owner: "platform" },
    });
    const retrievedVault = await client.beta.vaults.retrieve(createdVault.id);

    expect(createdVault).toMatchObject({
      id: expect.stringMatching(/^vlt_/),
      type: "vault",
      display_name: "Cloudflare production credentials",
      metadata: { owner: "platform" },
      archived_at: null,
    });
    expect(retrievedVault).toEqual(createdVault);

    const createdCredential = await client.beta.vaults.credentials.create(
      createdVault.id,
      {
        auth: {
          type: "static_bearer",
          token: "cf-bearer-secret",
          mcp_server_url: "https://mcp.example.com/sse",
        },
        display_name: "Cloudflare MCP bearer",
        metadata: { owner: "platform" },
      },
    );
    const retrievedCredential = await client.beta.vaults.credentials.retrieve(
      createdCredential.id,
      { vault_id: createdVault.id },
    );

    expect(createdCredential).toEqual({
      id: expect.stringMatching(/^vcrd_/),
      archived_at: null,
      auth: {
        type: "static_bearer",
        mcp_server_url: "https://mcp.example.com/sse",
      },
      created_at: expect.any(String),
      display_name: "Cloudflare MCP bearer",
      metadata: { owner: "platform" },
      type: "vault_credential",
      updated_at: expect.any(String),
      vault_id: createdVault.id,
    });
    expect(retrievedCredential).toEqual(createdCredential);
    expect(JSON.stringify(createdCredential)).not.toContain("cf-bearer-secret");

    const createdTunnel = await client.beta.tunnels.create({
      display_name: "Cloudflare production gateway",
    });
    expect(createdTunnel).toEqual({
      id: expect.stringMatching(/^tnl_/),
      archived_at: null,
      created_at: expect.any(String),
      display_name: "Cloudflare production gateway",
      domain: expect.stringMatching(/\.tunnels\.localhost$/),
      type: "tunnel",
    });
    await expect(client.beta.tunnels.retrieve(createdTunnel.id)).resolves.toEqual(
      createdTunnel,
    );
    const revealedTunnelToken = await client.beta.tunnels.revealToken(
      createdTunnel.id,
    );
    expect(revealedTunnelToken).toMatchObject({
      id: expect.stringMatching(/^ttok_/),
      tunnel_token: expect.stringMatching(/^tnl_tok_/),
      type: "tunnel_token",
    });
    const rotatedTunnelToken = await client.beta.tunnels.rotateToken(
      createdTunnel.id,
      { reason: "Cloudflare e2e rotation" },
    );
    expect(rotatedTunnelToken.id).not.toBe(revealedTunnelToken.id);
    expect(rotatedTunnelToken.tunnel_token).not.toBe(
      revealedTunnelToken.tunnel_token,
    );
    await expect(
      client.beta.tunnels.revealToken(createdTunnel.id),
    ).resolves.toEqual(rotatedTunnelToken);
    const createdTunnelCertificate =
      await client.beta.tunnels.certificates.create(createdTunnel.id, {
        ca_certificate_pem: testCertificatePem(),
      });
    expect(createdTunnelCertificate).toEqual({
      id: expect.stringMatching(/^tcrt_/),
      archived_at: null,
      created_at: expect.any(String),
      expires_at: null,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      tunnel_id: createdTunnel.id,
      type: "tunnel_certificate",
    });
    await expect(
      client.beta.tunnels.certificates.retrieve(createdTunnelCertificate.id, {
        tunnel_id: createdTunnel.id,
      }),
    ).resolves.toEqual(createdTunnelCertificate);
    const tunnelCertificatePage =
      await client.beta.tunnels.certificates.list(createdTunnel.id);
    expect(tunnelCertificatePage.data).toEqual([createdTunnelCertificate]);
    const archivedTunnelCertificate =
      await client.beta.tunnels.certificates.archive(
        createdTunnelCertificate.id,
        { tunnel_id: createdTunnel.id },
      );
    expect(archivedTunnelCertificate.archived_at).toEqual(expect.any(String));
    const archivedTunnel = await client.beta.tunnels.archive(createdTunnel.id);
    expect(archivedTunnel).toMatchObject({
      id: createdTunnel.id,
      archived_at: expect.any(String),
    });

    const createdUserProfile = await client.beta.userProfiles.create({
      access_type: "application",
      external_id: "cf-customer-01",
      metadata: { owner: "platform" },
      name: "Cloudflare Customer",
      relationship: "external",
    });
    const retrievedUserProfile = await client.beta.userProfiles.retrieve(
      createdUserProfile.id,
    );

    expect(createdUserProfile).toEqual({
      id: expect.stringMatching(/^uprof_/),
      created_at: expect.any(String),
      metadata: { owner: "platform" },
      trust_grants: {},
      type: "user_profile",
      updated_at: expect.any(String),
      access_type: "application",
      external_id: "cf-customer-01",
      name: "Cloudflare Customer",
      relationship: "external",
    });
    expect(retrievedUserProfile).toEqual(createdUserProfile);

    const createdDeployment = await client.beta.deployments.create({
      agent: { type: "agent", id: created.id, version: created.version },
      environment_id: createdEnvironment.id,
      initial_events: [
        {
          type: "system.message",
          content: [{ type: "text", text: "Use read-only checks" }],
        },
      ],
      name: "cf-repository-maintenance",
      metadata: { owner: "platform" },
      schedule: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "UTC",
      },
      vault_ids: [createdVault.id],
    });
    const retrievedDeployment = await client.beta.deployments.retrieve(
      createdDeployment.id,
    );

    expect(createdDeployment).toMatchObject({
      id: expect.stringMatching(/^depl_/),
      type: "deployment",
      agent: {
        id: created.id,
        type: "agent",
        version: created.version,
      },
      environment_id: createdEnvironment.id,
      name: "cf-repository-maintenance",
      status: "active",
      schedule: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "UTC",
        upcoming_runs_at: expect.any(Array),
      },
      vault_ids: [createdVault.id],
    });
    expect(retrievedDeployment).toEqual(createdDeployment);
    const pausedDeployment = await client.beta.deployments.pause(
      createdDeployment.id,
    );
    expect(pausedDeployment).toMatchObject({
      status: "paused",
      paused_reason: { type: "manual" },
    });
    const unpausedDeployment = await client.beta.deployments.unpause(
      createdDeployment.id,
    );
    expect(unpausedDeployment).toMatchObject({
      status: "active",
      paused_reason: null,
    });
    const deploymentRun = await client.beta.deployments.run(
      createdDeployment.id,
    );
    expect(deploymentRun).toMatchObject({
      id: expect.stringMatching(/^drun_/),
      type: "deployment_run",
      deployment_id: createdDeployment.id,
      session_id: expect.stringMatching(/^session_/),
      trigger_context: { type: "manual" },
      error: null,
    });
    await expect(
      client.beta.deploymentRuns.retrieve(deploymentRun.id),
    ).resolves.toEqual(deploymentRun);

    const polledWork = await client.beta.environments.work.poll(
      createdEnvironment.id,
      { "Anthropic-Worker-ID": "cf-worker-01" },
    );
    expect(polledWork).not.toBeNull();
    if (polledWork === null) throw new Error("Expected queued Environment Work");
    expect(polledWork).toMatchObject({
      id: expect.stringMatching(/^work_/),
      type: "work",
      data: { type: "session", id: deploymentRun.session_id },
      environment_id: createdEnvironment.id,
      secret: expect.any(String),
      state: "queued",
    });
    expect(decodeWorkSecret(polledWork.secret!)).toEqual({
      sessions_token: expect.stringMatching(/^sk-ant-req-/),
      api_base_url: "http://localhost",
    });
    expect(
      await client.beta.environments.work.retrieve(polledWork.id, {
        environment_id: createdEnvironment.id,
      }),
    ).toEqual({ ...polledWork, secret: null });
    expect(
      await client.beta.environments.work.update(polledWork.id, {
        environment_id: createdEnvironment.id,
        metadata: { worker: "cf-worker-01" },
      }),
    ).toMatchObject({ metadata: { worker: "cf-worker-01" }, secret: null });
    const workPage = await client.beta.environments.work.list(
      createdEnvironment.id,
    );
    expect(workPage.data).toHaveLength(1);
    expect(workPage.data[0]).toMatchObject({ id: polledWork.id, secret: null });
    await expect(
      client.beta.environments.work.stats(createdEnvironment.id),
    ).resolves.toEqual({
      type: "work_queue_stats",
      depth: 0,
      pending: 1,
      oldest_queued_at: expect.any(String),
      workers_polling: 1,
    });
    const acknowledgedWork = await client.beta.environments.work.ack(
      polledWork.id,
      { environment_id: createdEnvironment.id },
    );
    expect(acknowledgedWork).toMatchObject({
      id: polledWork.id,
      state: "starting",
      acknowledged_at: expect.any(String),
      secret: null,
    });
    const heartbeat = await client.beta.environments.work.heartbeat(
      polledWork.id,
      {
        environment_id: createdEnvironment.id,
        desired_ttl_seconds: 120,
        expected_last_heartbeat: "NO_HEARTBEAT",
      },
    );
    expect(heartbeat).toEqual({
      type: "work_heartbeat",
      last_heartbeat: expect.any(String),
      lease_extended: true,
      state: "active",
      ttl_seconds: 120,
    });
    const stoppedWork = await client.beta.environments.work.stop(
      polledWork.id,
      { environment_id: createdEnvironment.id, force: true },
    );
    expect(stoppedWork).toMatchObject({
      id: polledWork.id,
      state: "stopped",
      stop_requested_at: expect.any(String),
      stopped_at: expect.any(String),
      secret: null,
    });
    await expect(
      client.beta.environments.work.stats(createdEnvironment.id),
    ).resolves.toEqual({
      type: "work_queue_stats",
      depth: 0,
      pending: 0,
      oldest_queued_at: null,
      workers_polling: 1,
    });

    const createdSession = await client.beta.sessions.create({
      agent: { type: "agent", id: created.id, version: created.version },
      environment_id: "env-local-runtime",
      title: "Cloudflare managed session",
    });
    const retrievedSession = await client.beta.sessions.retrieve(
      createdSession.id,
    );

    expect(createdSession).toMatchObject({
      id: expect.stringMatching(/^session_/),
      type: "session",
      agent: {
        id: created.id,
        type: "agent",
        version: created.version,
      },
      environment_id: "env-local-runtime",
      title: "Cloudflare managed session",
      status: "running",
    });
    expect(retrievedSession).toEqual(createdSession);
    expect(await client.beta.sessions.delete(createdSession.id)).toEqual({
      id: createdSession.id,
      type: "session_deleted",
    });
  });
});

function decodeWorkSecret(secret: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(secret, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

async function waitForTerminalDream<T extends { status: string }>(
  retrieve: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const dream = await retrieve();
    if (!["pending", "running"].includes(dream.status)) return dream;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Dream did not reach a terminal state");
}

function testCertificatePem(): string {
  return [
    "-----BEGIN CERTIFICATE-----",
    Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]).toString("base64"),
    "-----END CERTIFICATE-----",
  ].join("\n");
}
