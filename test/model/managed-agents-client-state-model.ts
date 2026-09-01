import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

type ApiErrorPayload = {
  type?: string;
  message?: string;
  conflicting_memory_id?: string;
  conflicting_path?: string;
};

type ApiFailure = {
  status?: number;
  type?: string;
  error?: {
    type?: string;
    error?: ApiErrorPayload;
  };
};

type DeploymentState = "active" | "paused" | "archived";

interface StateModelOptions {
  client: Anthropic;
  model: string;
  prefix: string;
}

/**
 * Refinement check for the public Managed Agents state machines.
 *
 * Every command goes through the real @anthropic-ai/sdk client. The model below
 * is deliberately independent from OpenMA's application/store implementation:
 * its expected transitions come from the public SDK/API contract.
 */
export async function verifyManagedAgentsClientStateModel(
  options: StateModelOptions,
): Promise<void> {
  const { client, model, prefix } = options;
  const trace: string[] = [];
  let agentId: string | undefined;
  let raceAgentIds: string[] = [];
  let environmentId: string | undefined;
  let archivedEnvironmentId: string | undefined;
  let sessionId: string | undefined;
  let deploymentId: string | undefined;
  let memoryStoreId: string | undefined;
  let memoryId: string | undefined;

  const step = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    trace.push(name);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Error) {
        error.message = `${error.message}\nmodel trace: ${trace.join(" -> ")}`;
      }
      throw error;
    }
  };

  try {
    await step("missing agent is not found", async () => {
      await expectApiError(
        client.beta.agents.retrieve(`agent_missing_${prefix}`),
        404,
        "not_found_error",
      );
    });

    const created = await step("agent absent -> active(v1)", () =>
      client.beta.agents.create({
        name: `${prefix}-agent-v1`,
        model,
        metadata: { model_check: prefix },
      }));
    agentId = created.id;
    assert.equal(created.version, 1);
    assert.equal(created.archived_at, null);

    const versionTwo = await step("agent CAS(v1) -> active(v2)", () =>
      client.beta.agents.update(created.id, {
        name: `${prefix}-agent-v2`,
        version: 1,
      }));
    assert.equal(versionTwo.version, 2);

    await step("stale agent CAS is rejected without mutation", async () => {
      const before = await client.beta.agents.retrieve(created.id);
      await expectApiError(
        client.beta.agents.update(created.id, {
          name: `${prefix}-stale-overwrite`,
          version: 1,
        }),
        409,
        "conflict_error",
      );
      assert.deepEqual(await client.beta.agents.retrieve(created.id), before);
    });

    const concurrentWinner = await step(
      "two agent CAS(v2) linearize to one success",
      async () => {
        const names = [`${prefix}-cas-left`, `${prefix}-cas-right`] as const;
        const outcomes = await Promise.allSettled(
          names.map((name) => client.beta.agents.update(created.id, {
            name,
            version: 2,
          })),
        );
        const successes = outcomes.filter(
          (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof client.beta.agents.update>>> =>
            outcome.status === "fulfilled",
        );
        const failures = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
        );
        assert.equal(successes.length, 1, "exactly one competing CAS must commit");
        assert.equal(failures.length, 1, "exactly one competing CAS must conflict");
        assertApiFailure(failures[0]!.reason, 409, "conflict_error");
        assert.equal(successes[0]!.value.version, 3);
        return successes[0]!.value;
      },
    );
    assert.deepEqual(await client.beta.agents.retrieve(created.id), concurrentWinner);

    await step("agent version history is monotonic and complete", async () => {
      const versions = await client.beta.agents.versions.list(created.id, {
        limit: 100,
      });
      assert.deepEqual(versions.data.map(({ version }) => version), [3, 2, 1]);
    });

    const environment = await step("environment absent -> active", () =>
      client.beta.environments.create({
        name: `${prefix}-environment`,
        scope: "organization",
        config: { type: "self_hosted" },
      }));
    environmentId = environment.id;

    const session = await step("active dependencies -> session", () =>
      client.beta.sessions.create({
        agent: {
          type: "agent",
          id: concurrentWinner.id,
          version: concurrentWinner.version,
        },
        environment_id: environment.id,
        title: `${prefix}-session`,
      }));
    sessionId = session.id;

    const deployment = await step("deployment absent -> active", () =>
      client.beta.deployments.create({
        agent: {
          type: "agent",
          id: concurrentWinner.id,
          version: concurrentWinner.version,
        },
        environment_id: environment.id,
        initial_events: [{
          type: "system.message",
          content: [{ type: "text", text: "state model fixture" }],
        }],
        name: `${prefix}-deployment`,
      }));
    deploymentId = deployment.id;

    await verifyDeploymentStateMachine(client, deployment.id, trace);

    const memoryStore = await step("memory store absent -> active", () =>
      client.beta.memoryStores.create({ name: `${prefix}-memory-store` }));
    memoryStoreId = memoryStore.id;
    const memory = await step("memory path absent -> present", () =>
      client.beta.memoryStores.memories.create(memoryStore.id, {
        path: `/${prefix}/state.txt`,
        content: "state-a",
        view: "full",
      }));
    memoryId = memory.id;
    await verifyMemoryCasModel(client, memoryStore.id, memory, trace);

    const archivedEnvironment = await step("environment active -> archived", () =>
      client.beta.environments.archive(environment.id));
    archivedEnvironmentId = archivedEnvironment.id;
    assert.ok(archivedEnvironment.archived_at);

    await step("archived environment is read-only", async () => {
      const before = await client.beta.environments.retrieve(environment.id);
      await expectApiError(
        client.beta.environments.update(environment.id, {
          name: `${prefix}-forbidden-environment-update`,
        }),
        409,
        "conflict_error",
      );
      assert.deepEqual(await client.beta.environments.retrieve(environment.id), before);
    });

    await step("archived environment rejects new session", async () => {
      await expectApiError(
        client.beta.sessions.create({
          agent: {
            type: "agent",
            id: concurrentWinner.id,
            version: concurrentWinner.version,
          },
          environment_id: environment.id,
          title: `${prefix}-forbidden-environment-session`,
        }),
        404,
        "not_found_error",
      );
    });

    await step("existing session can stop after environment archive", async () => {
      assert.deepEqual(await client.beta.sessions.delete(session.id), {
        id: session.id,
        type: "session_deleted",
      });
      sessionId = undefined;
    });

    const fallbackEnvironment = await step("second environment absent -> active", () =>
      client.beta.environments.create({
        name: `${prefix}-fallback-environment`,
        scope: "organization",
        config: { type: "self_hosted" },
      }));
    environmentId = fallbackEnvironment.id;

    const archivedAgent = await step("agent active -> archived", () =>
      client.beta.agents.archive(created.id));
    assert.ok(archivedAgent.archived_at);

    await step("archived agent is read-only", async () => {
      const before = await client.beta.agents.retrieve(created.id);
      await expectApiError(
        client.beta.agents.update(created.id, {
          name: `${prefix}-forbidden-agent-update`,
          version: before.version,
        }),
        409,
        "conflict_error",
      );
      assert.deepEqual(await client.beta.agents.retrieve(created.id), before);
    });

    await step("archived agent rejects new session", async () => {
      await expectApiError(
        client.beta.sessions.create({
          agent: {
            type: "agent",
            id: archivedAgent.id,
            version: archivedAgent.version,
          },
          environment_id: fallbackEnvironment.id,
          title: `${prefix}-forbidden-agent-session`,
        }),
        404,
        "not_found_error",
      );
    });

    await step("archived agent visibility obeys list mode", async () => {
      const activePage = await client.beta.agents.list({ limit: 100 });
      assert.equal(activePage.data.some(({ id }) => id === created.id), false);
      const allPage = await client.beta.agents.list({
        include_archived: true,
        limit: 100,
      });
      assert.equal(allPage.data.some(({ id }) => id === created.id), true);
    });

    raceAgentIds = await step("archive/update races preserve terminal state", async () => {
      const ids: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const raceAgent = await client.beta.agents.create({
          name: `${prefix}-race-${index}`,
          model,
        });
        ids.push(raceAgent.id);
        const outcomes = await Promise.allSettled([
          client.beta.agents.archive(raceAgent.id),
          client.beta.agents.update(raceAgent.id, {
            name: `${prefix}-race-${index}-updated`,
            version: raceAgent.version,
          }),
        ]);
        assert.equal(outcomes[0]!.status, "fulfilled", "archive must commit");
        if (outcomes[1]!.status === "rejected") {
          assertApiFailure(outcomes[1]!.reason, 409, "conflict_error");
        }
        const final = await client.beta.agents.retrieve(raceAgent.id);
        assert.ok(final.archived_at, "an archive/update race must end archived");
      }
      return ids;
    });
  } finally {
    await bestEffort(async () => {
      if (deploymentId !== undefined) await client.beta.deployments.archive(deploymentId);
    });
    await bestEffort(async () => {
      if (sessionId !== undefined) await client.beta.sessions.delete(sessionId);
    });
    await bestEffort(async () => {
      if (memoryId !== undefined && memoryStoreId !== undefined) {
        const current = await client.beta.memoryStores.memories.retrieve(memoryId, {
          memory_store_id: memoryStoreId,
          view: "full",
        });
        await client.beta.memoryStores.memories.delete(memoryId, {
          memory_store_id: memoryStoreId,
          expected_content_sha256: current.content_sha256,
        });
      }
    });
    await bestEffort(async () => {
      if (memoryStoreId !== undefined) await client.beta.memoryStores.delete(memoryStoreId);
    });
    await bestEffort(async () => {
      if (environmentId !== undefined) await client.beta.environments.delete(environmentId);
    });
    await bestEffort(async () => {
      if (archivedEnvironmentId !== undefined) {
        await client.beta.environments.delete(archivedEnvironmentId);
      }
    });
    await bestEffort(async () => {
      if (agentId !== undefined) await client.beta.agents.archive(agentId);
    });
    for (const id of raceAgentIds) {
      await bestEffort(() => client.beta.agents.archive(id));
    }
  }
}

async function verifyDeploymentStateMachine(
  client: Anthropic,
  deploymentId: string,
  trace: string[],
): Promise<void> {
  let state: DeploymentState = "active";
  const commands = [
    { action: "pause", outcome: "success", next: "paused" },
    { action: "pause", outcome: "conflict", next: "paused" },
    { action: "unpause", outcome: "success", next: "active" },
    { action: "unpause", outcome: "conflict", next: "active" },
    { action: "archive", outcome: "success", next: "archived" },
    { action: "archive", outcome: "conflict", next: "archived" },
    { action: "pause", outcome: "conflict", next: "archived" },
    { action: "unpause", outcome: "conflict", next: "archived" },
    { action: "run", outcome: "conflict", next: "archived" },
    { action: "update", outcome: "conflict", next: "archived" },
  ] as const;

  for (const command of commands) {
    trace.push(`deployment ${state} --${command.action}--> ${command.next}`);
    const invoke = () => {
      switch (command.action) {
        case "pause": return client.beta.deployments.pause(deploymentId);
        case "unpause": return client.beta.deployments.unpause(deploymentId);
        case "archive": return client.beta.deployments.archive(deploymentId);
        case "run": return client.beta.deployments.run(deploymentId);
        case "update": return client.beta.deployments.update(deploymentId, {
          name: "forbidden archived update",
        });
      }
    };
    if (command.outcome === "conflict") {
      await expectApiError(
        invoke(),
        409,
        "conflict_error",
        `deployment ${state} --${command.action}--> ${command.next}`,
      );
    } else {
      const result = await invoke();
      if (command.next === "archived") assert.ok("archived_at" in result && result.archived_at);
      else assert.equal("status" in result ? result.status : undefined, command.next);
    }
    state = command.next;
    const persisted = await client.beta.deployments.retrieve(deploymentId);
    if (state === "archived") assert.ok(persisted.archived_at);
    else assert.equal(persisted.status, state);
  }

  const activePage = await client.beta.deployments.list({ limit: 100 });
  assert.equal(activePage.data.some(({ id }) => id === deploymentId), false);
  const allPage = await client.beta.deployments.list({
    include_archived: true,
    limit: 100,
  });
  assert.equal(allPage.data.some(({ id }) => id === deploymentId), true);
}

async function verifyMemoryCasModel(
  client: Anthropic,
  memoryStoreId: string,
  initial: { id: string; content: string | null; content_sha256: string; path: string },
  trace: string[],
): Promise<void> {
  let current = initial;
  trace.push("memory stale SHA -> precondition conflict");
  const stalePayload = await expectApiError(
    client.beta.memoryStores.memories.update(initial.id, {
      memory_store_id: memoryStoreId,
      content: "forbidden-stale-content",
      precondition: { type: "content_sha256", content_sha256: "0".repeat(64) },
      view: "full",
    }),
    409,
    "memory_precondition_failed_error",
  );
  assert.equal(stalePayload.type, "memory_precondition_failed_error");
  assert.deepEqual(
    await client.beta.memoryStores.memories.retrieve(initial.id, {
      memory_store_id: memoryStoreId,
      view: "full",
    }),
    current,
  );

  trace.push("memory matching SHA -> update");
  current = await client.beta.memoryStores.memories.update(initial.id, {
    memory_store_id: memoryStoreId,
    content: "state-b",
    precondition: {
      type: "content_sha256",
      content_sha256: current.content_sha256,
    },
    view: "full",
  });
  assert.equal(current.content, "state-b");

  trace.push("memory stale SHA + identical target -> idempotent success");
  const idempotent = await client.beta.memoryStores.memories.update(initial.id, {
    memory_store_id: memoryStoreId,
    content: current.content,
    path: current.path,
    precondition: {
      type: "content_sha256",
      content_sha256: initial.content_sha256,
    },
    view: "full",
  });
  assert.deepEqual(idempotent, current);

  trace.push("two memory CAS operations linearize to one success");
  const baseSha = current.content_sha256;
  const outcomes = await Promise.allSettled([
    client.beta.memoryStores.memories.update(initial.id, {
      memory_store_id: memoryStoreId,
      content: "state-c-left",
      precondition: { type: "content_sha256", content_sha256: baseSha },
      view: "full",
    }),
    client.beta.memoryStores.memories.update(initial.id, {
      memory_store_id: memoryStoreId,
      content: "state-c-right",
      precondition: { type: "content_sha256", content_sha256: baseSha },
      view: "full",
    }),
  ]);
  const successes = outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<typeof current> => outcome.status === "fulfilled",
  );
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assertApiFailure(failures[0]!.reason, 409, "memory_precondition_failed_error");
  current = successes[0]!.value;
  assert.deepEqual(
    await client.beta.memoryStores.memories.retrieve(initial.id, {
      memory_store_id: memoryStoreId,
      view: "full",
    }),
    current,
  );

  trace.push("duplicate memory path -> path conflict");
  const pathConflict = await expectApiError(
    client.beta.memoryStores.memories.create(memoryStoreId, {
      path: current.path,
      content: "duplicate path",
      view: "full",
    }),
    409,
    "memory_path_conflict_error",
  );
  assert.equal(pathConflict.conflicting_memory_id, current.id);
  assert.equal(pathConflict.conflicting_path, current.path);
}

async function expectApiError(
  operation: Promise<unknown>,
  status: number,
  type: string,
  context?: string,
): Promise<ApiErrorPayload> {
  try {
    await operation;
  } catch (error) {
    return assertApiFailure(error, status, type);
  }
  assert.fail(
    `Expected SDK request to fail with ${status} ${type}${context === undefined ? "" : ` (${context})`}`,
  );
}

function assertApiFailure(
  error: unknown,
  status: number,
  type: string,
): ApiErrorPayload {
  assert.ok(error !== null && typeof error === "object", "SDK must throw a structured error");
  const failure = error as ApiFailure;
  assert.equal(failure.status, status);
  const payload = failure.error?.error;
  assert.equal(failure.type ?? payload?.type, type);
  assert.equal(payload?.type, type);
  assert.equal(typeof payload.message, "string");
  return payload;
}

async function bestEffort(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    // The model intentionally reaches terminal/deleted states; cleanup is only
    // for fixtures that remain after an earlier failed assertion.
  }
}
