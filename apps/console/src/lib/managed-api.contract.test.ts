import { beforeEach, describe, expect, it, vi } from "vitest";
import { createManagedApiClient } from "./managed-api";

describe("Console Managed Agents client", () => {
  const request = vi.fn();
  const raw = vi.fn();
  const stream = vi.fn();

  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue({});
    raw.mockReset();
    raw.mockResolvedValue(new Response("binary"));
    stream.mockReset();
  });

  it("serializes SDK list parameters and repeated status filters", async () => {
    const client = createManagedApiClient(request);

    await client.sessions.list({
      limit: 20,
      page: "page_2",
      agent_id: "agent_1",
      statuses: ["running", "idle"],
      "created_at[gte]": "2026-01-01T00:00:00.000Z",
    });

    expect(request).toHaveBeenCalledWith(
      "/v1/sessions?limit=20&page=page_2&agent_id=agent_1&statuses%5B%5D=running&statuses%5B%5D=idle&created_at%5Bgte%5D=2026-01-01T00%3A00%3A00.000Z",
    );
  });

  it("uses POST for Managed Agent updates", async () => {
    const client = createManagedApiClient(request);
    await client.agents.update("agent/1", { name: "Renamed", version: 3 });

    expect(request).toHaveBeenCalledWith("/v1/agents/agent%2F1", {
      method: "POST",
      body: JSON.stringify({ name: "Renamed", version: 3 }),
    });
  });

  it("keeps Files pagination on the official Files API shape", async () => {
    const client = createManagedApiClient(request);
    await client.files.list({ limit: 20, before_id: "file_1" });

    expect(request).toHaveBeenCalledWith(
      "/v1/files?limit=20&before_id=file_1",
    );
  });

  it("sends the SDK event body without an OMA envelope", async () => {
    const client = createManagedApiClient(request);
    await client.sessions.events.send("session_1", {
      events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    });

    expect(request).toHaveBeenCalledWith("/v1/sessions/session_1/events", {
      method: "POST",
      body: JSON.stringify({
        events: [
          { type: "user.message", content: [{ type: "text", text: "hi" }] },
        ],
      }),
    });
  });

  it("covers the remaining Managed resource namespaces with SDK paths", async () => {
    const client = createManagedApiClient(request);

    await client.environments.update("env/1", { name: "Sandbox" });
    await client.vaults.credentials.update("cred/1", {
      vault_id: "vault/1",
      display_name: "GitHub",
    });
    await client.memoryStores.memories.update("memory/1", {
      memory_store_id: "store/1",
      content: "updated",
      view: "full",
    });
    await client.memoryStores.memoryVersions.list("store/1", {
      memory_id: "memory/1",
      page: "page_2",
    });
    await client.sessions.resources.add("session/1", {
      type: "file",
      file_id: "file/1",
    });
    await client.sessions.threads.archive("thread/1", {
      session_id: "session/1",
    });
    await client.models.list({ before_id: "model/1", limit: 20 });

    expect(request.mock.calls).toEqual([
      ["/v1/environments/env%2F1", {
        method: "POST",
        body: JSON.stringify({ name: "Sandbox" }),
      }],
      ["/v1/vaults/vault%2F1/credentials/cred%2F1", {
        method: "POST",
        body: JSON.stringify({ display_name: "GitHub" }),
      }],
      ["/v1/memory_stores/store%2F1/memories/memory%2F1?view=full", {
        method: "POST",
        body: JSON.stringify({ content: "updated" }),
      }],
      ["/v1/memory_stores/store%2F1/memory_versions?memory_id=memory%2F1&page=page_2"],
      ["/v1/sessions/session%2F1/resources", {
        method: "POST",
        body: JSON.stringify({ type: "file", file_id: "file/1" }),
      }],
      ["/v1/sessions/session%2F1/threads/thread%2F1/archive", {
        method: "POST",
        body: JSON.stringify({}),
      }],
      ["/v1/models?before_id=model%2F1&limit=20"],
    ]);
  });

  it("builds official multipart skill uploads with files[]", async () => {
    const client = createManagedApiClient(request);
    const file = new File(["# Skill"], "SKILL.md", { type: "text/markdown" });

    await client.skills.create({ files: [file], display_title: "Research" });

    const [path, init] = request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/v1/skills");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).getAll("files[]")).toEqual([file]);
    expect((init.body as FormData).get("display_title")).toBe("Research");
  });

  it("covers the complete Deployment and Deployment Run SDK resources", async () => {
    const client = createManagedApiClient(request);

    await client.deployments.create({
      agent: "agent_1",
      environment_id: "env_1",
      initial_events: [
        { type: "user.message", content: [{ type: "text", text: "start" }] },
      ],
      name: "Nightly",
    });
    await client.deployments.retrieve("depl/1");
    await client.deployments.update("depl/1", { name: "Renamed" });
    await client.deployments.list({ status: "active", limit: 10 });
    await client.deployments.archive("depl/1");
    await client.deployments.pause("depl/1");
    await client.deployments.run("depl/1");
    await client.deployments.unpause("depl/1");
    await client.deploymentRuns.retrieve("run/1");
    await client.deploymentRuns.list({
      deployment_id: "depl/1",
      has_error: false,
    });

    expect(request.mock.calls).toEqual([
      ["/v1/deployments", {
        method: "POST",
        body: JSON.stringify({
          agent: "agent_1",
          environment_id: "env_1",
          initial_events: [
            { type: "user.message", content: [{ type: "text", text: "start" }] },
          ],
          name: "Nightly",
        }),
      }],
      ["/v1/deployments/depl%2F1"],
      ["/v1/deployments/depl%2F1", {
        method: "POST",
        body: JSON.stringify({ name: "Renamed" }),
      }],
      ["/v1/deployments?status=active&limit=10"],
      ["/v1/deployments/depl%2F1/archive", {
        method: "POST",
        body: JSON.stringify({}),
      }],
      ["/v1/deployments/depl%2F1/pause", {
        method: "POST",
        body: JSON.stringify({}),
      }],
      ["/v1/deployments/depl%2F1/run", {
        method: "POST",
        body: JSON.stringify({}),
      }],
      ["/v1/deployments/depl%2F1/unpause", {
        method: "POST",
        body: JSON.stringify({}),
      }],
      ["/v1/deployment_runs/run%2F1"],
      ["/v1/deployment_runs?deployment_id=depl%2F1&has_error=false"],
    ]);
  });

  it("covers the complete Dream lifecycle SDK resource", async () => {
    const client = createManagedApiClient(request);

    await client.dreams.create({
      inputs: [{ type: "memory_store", memory_store_id: "store/1" }],
      model: "model_1",
    });
    await client.dreams.retrieve("dream/1");
    await client.dreams.list({
      statuses: ["pending", "running"],
      include_archived: true,
    });
    await client.dreams.archive("dream/1");
    await client.dreams.cancel("dream/1");

    expect(request.mock.calls).toEqual([
      ["/v1/dreams", {
        method: "POST",
        body: JSON.stringify({
          inputs: [{ type: "memory_store", memory_store_id: "store/1" }],
          model: "model_1",
        }),
      }],
      ["/v1/dreams/dream%2F1"],
      ["/v1/dreams?statuses%5B%5D=pending&statuses%5B%5D=running&include_archived=true"],
      ["/v1/dreams/dream%2F1/archive", {
        method: "POST",
        body: JSON.stringify({}),
      }],
      ["/v1/dreams/dream%2F1/cancel", {
        method: "POST",
        body: JSON.stringify({}),
      }],
    ]);
  });

  it("covers self-hosted Environment Work including worker headers", async () => {
    const client = createManagedApiClient(request);

    await client.environments.work.list("env/1", { page: "page_2" });
    await client.environments.work.retrieve("work/1", { environment_id: "env/1" });
    await client.environments.work.update("work/1", {
      environment_id: "env/1",
      metadata: { runner: "local" },
    });
    await client.environments.work.ack("work/1", { environment_id: "env/1" });
    await client.environments.work.heartbeat("work/1", {
      environment_id: "env/1",
      desired_ttl_seconds: 60,
      expected_last_heartbeat: "NO_HEARTBEAT",
    });
    await client.environments.work.poll("env/1", {
      block_ms: 999,
      "Anthropic-Worker-ID": "worker/1",
    });
    await client.environments.work.stats("env/1");
    await client.environments.work.stop("work/1", {
      environment_id: "env/1",
      force: true,
    });

    expect(request.mock.calls).toEqual([
      ["/v1/environments/env%2F1/work?page=page_2"],
      ["/v1/environments/env%2F1/work/work%2F1"],
      ["/v1/environments/env%2F1/work/work%2F1", {
        method: "POST",
        body: JSON.stringify({ metadata: { runner: "local" } }),
      }],
      ["/v1/environments/env%2F1/work/work%2F1/ack", {
        method: "POST",
        body: JSON.stringify({}),
      }],
      ["/v1/environments/env%2F1/work/work%2F1/heartbeat?desired_ttl_seconds=60&expected_last_heartbeat=NO_HEARTBEAT", {
        method: "POST",
        body: JSON.stringify({}),
      }],
      ["/v1/environments/env%2F1/work/poll?block_ms=999", {
        headers: { "Anthropic-Worker-ID": "worker/1" },
      }],
      ["/v1/environments/env%2F1/work/stats"],
      ["/v1/environments/env%2F1/work/work%2F1/stop", {
        method: "POST",
        body: JSON.stringify({ force: true }),
      }],
    ]);
  });

  it("covers Tunnels, Certificates, and User Profiles with SDK nesting", async () => {
    const client = createManagedApiClient(request);

    await client.tunnels.create({ display_name: "Office" });
    await client.tunnels.retrieve("tunnel/1");
    await client.tunnels.list({ include_archived: true });
    await client.tunnels.archive("tunnel/1");
    await client.tunnels.revealToken("tunnel/1");
    await client.tunnels.rotateToken("tunnel/1", { reason: "scheduled" });
    await client.tunnels.certificates.create("tunnel/1", {
      ca_certificate_pem: "PEM",
    });
    await client.tunnels.certificates.retrieve("cert/1", {
      tunnel_id: "tunnel/1",
    });
    await client.tunnels.certificates.list("tunnel/1", {
      include_archived: true,
    });
    await client.tunnels.certificates.archive("cert/1", {
      tunnel_id: "tunnel/1",
    });
    await client.userProfiles.create({ external_id: "user/1" });
    await client.userProfiles.retrieve("profile/1");
    await client.userProfiles.update("profile/1", { name: "Ada" });
    await client.userProfiles.list({ order: "asc" });
    await client.userProfiles.createEnrollmentURL("profile/1");

    expect(request.mock.calls).toEqual([
      ["/v1/tunnels", { method: "POST", body: JSON.stringify({ display_name: "Office" }) }],
      ["/v1/tunnels/tunnel%2F1"],
      ["/v1/tunnels?include_archived=true"],
      ["/v1/tunnels/tunnel%2F1/archive", { method: "POST", body: JSON.stringify({}) }],
      ["/v1/tunnels/tunnel%2F1/reveal_token", { method: "POST", body: JSON.stringify({}) }],
      ["/v1/tunnels/tunnel%2F1/rotate_token", { method: "POST", body: JSON.stringify({ reason: "scheduled" }) }],
      ["/v1/tunnels/tunnel%2F1/certificates", { method: "POST", body: JSON.stringify({ ca_certificate_pem: "PEM" }) }],
      ["/v1/tunnels/tunnel%2F1/certificates/cert%2F1"],
      ["/v1/tunnels/tunnel%2F1/certificates?include_archived=true"],
      ["/v1/tunnels/tunnel%2F1/certificates/cert%2F1/archive", { method: "POST", body: JSON.stringify({}) }],
      ["/v1/user_profiles", { method: "POST", body: JSON.stringify({ external_id: "user/1" }) }],
      ["/v1/user_profiles/profile%2F1"],
      ["/v1/user_profiles/profile%2F1", { method: "POST", body: JSON.stringify({ name: "Ada" }) }],
      ["/v1/user_profiles?order=asc"],
      ["/v1/user_profiles/profile%2F1/enrollment_url", { method: "POST", body: JSON.stringify({}) }],
    ]);
  });

  it("uses raw transport for SDK binary download responses", async () => {
    const client = createManagedApiClient({ request, raw, stream });

    await client.files.download("file/1");
    await client.skills.versions.download("v/1", { skill_id: "skill/1" });

    expect(raw.mock.calls).toEqual([
      ["/v1/files/file%2F1/content", { headers: { Accept: "application/binary" } }],
      ["/v1/skills/skill%2F1/versions/v%2F1/content", { headers: { Accept: "application/binary" } }],
    ]);
  });

  it("uses async-iterable transport for SDK session and thread streams", async () => {
    const sessionEvents = { async *[Symbol.asyncIterator]() {} };
    const threadEvents = { async *[Symbol.asyncIterator]() {} };
    stream.mockResolvedValueOnce(sessionEvents).mockResolvedValueOnce(threadEvents);
    const client = createManagedApiClient({ request, raw, stream });
    const abort = new AbortController();

    await expect(client.sessions.events.stream("session/1", {
      event_deltas: ["agent.message", "agent.thinking"],
    }, { signal: abort.signal })).resolves.toBe(sessionEvents);
    await expect(client.sessions.threads.events.stream("thread/1", {
      session_id: "session/1",
      event_deltas: ["agent.message"],
    }, { signal: abort.signal })).resolves.toBe(threadEvents);

    expect(stream.mock.calls).toEqual([
      ["/v1/sessions/session%2F1/events/stream?event_deltas%5B%5D=agent.message&event_deltas%5B%5D=agent.thinking", { signal: abort.signal }],
      ["/v1/sessions/session%2F1/threads/thread%2F1/stream?event_deltas%5B%5D=agent.message", { signal: abort.signal }],
    ]);
  });
});
