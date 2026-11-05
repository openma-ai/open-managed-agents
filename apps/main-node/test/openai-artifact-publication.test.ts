import { describe, expect, it, vi } from "vitest";
import { resourcesFixture } from "../../../packages/openai-agents-compat/test/helpers/resources";
import { encodeResourceMetadata } from "../../../packages/openai-agents-compat/src/resource-metadata";
import { createNodeOpenAIArtifactPublisher, withReportedArtifactPublication } from "../../../packages/control-plane-node/src/openai-artifact-publication";

/** `sessionExecutionEventBatches` splits each event batch per lane and uses the
 * id of the lane's first event other than `system.message` as the execution id;
 * bootstrap event ids are `bootstrap_${sessionId}:${index}`. */
type Round = "bootstrap" | "bootstrap_after_outcome" | "bootstrap_after_system" | "follow_up";
async function fixture(mode = "completed", environmentType = "openai_hosted", round: Round = "follow_up") {
  const resources = resourcesFixture();
  const session: any = { id: "session", environmentId: "native-env", agent: { id: "agent" }, createdAt: new Date(100000).toISOString(), metadata: encodeResourceMetadata({}, "session", { sealed: await resources.secrets.seal(JSON.stringify({ agent: {}, environment: { type: environmentType }, environmentId: "native-env" })) }) };
  const input = { type: "user.message", content: [{ type: "text", text: "make file" }] };
  const outcome = { type: "user.define_outcome", description: "File exists", rubric: { type: "text", content: "report.bin exists" }, maxIterations: 1 };
  const system = { type: "system.message", content: [{ type: "text", text: "Be brief" }] };
  const initialEvents: any[] = round === "bootstrap" ? [input] : round === "bootstrap_after_outcome" ? [outcome, input] : round === "bootstrap_after_system" ? [system, input] : [];
  // A leading system.message is skipped; a leading define_outcome starts the batch.
  const executionId = round === "bootstrap" || round === "bootstrap_after_outcome" ? "bootstrap_session:0" : round === "bootstrap_after_system" ? "bootstrap_session:1" : "sevt_input";
  const facts: any[] = round === "bootstrap" ? [] : [{ event: { ...input, id: executionId } }];
  facts.push({ executionId, event: { id: "running", type: "session.status_running" } });
  if (mode === "cancelled") facts.push({ event: { id: "cancel", type: "user.interrupt" } });
  if (mode === "failed") facts.push({ executionId, event: { id: "failure", type: "session.error", error: { type: "unknown_error", message: "failed", retryStatus: "terminal" } } });
  if (mode === "requires_action") facts.push({ executionId, event: { id: "call", type: "agent.custom_tool_use", name: "lookup", input: {} } });
  if (mode === "tool_confirmation") facts.push({ executionId, event: { id: "bash", type: "agent.tool_use", name: "bash", input: { command: "true" } } });
  const waiting = mode === "requires_action" || mode === "tool_confirmation";
  facts.push({ executionId, event: { id: "idle", type: "session.status_idle", stopReason: waiting ? { type: "requires_action", eventIds: [mode === "requires_action" ? "call" : "bash"] } : { type: "end_turn" } } });
  const bytes = new Uint8Array([0, 1, 127, 255]);
  const sandbox = { setEnvVars: vi.fn(async () => {}), exec: vi.fn(async () => Buffer.from("./outputs/report.bin\0").toString("base64")), readFileBytes: vi.fn(async () => bytes) };
  const history = { loadSessionRuntimeHistory: async () => ({ type: "found" as const, revision: 2, initialEvents, events: facts.map(row => row.event), orderedEvents: facts.map((row, index) => ({ ...row, position: { revision: 2, index } })) }) };
  const isFenceActive = vi.fn(async () => true);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const dependencies = { historyForWorkspace: () => history, filesForWorkspace: () => resources.files, secrets: resources.secrets, isFenceActive, environmentId: () => "oai_env_session", logger };
  const fence = (id: string): any => ({ workspaceId: "workspace_a", session, environment: { id: "native-env" }, sandbox, runtimeGeneration: "runtime", executionFence: { workspaceId: "workspace_a", sessionId: "session", executionId: id } });
  const skipped = () => Object.values(logger).flatMap(log => log.mock.calls.map(([fields]: any[]) => fields.reason));
  return { ...resources, executionId, input: fence(executionId), fence, facts, bytes, sandbox, dependencies, isFenceActive, logger, skipped, publish: createNodeOpenAIArtifactPublisher(dependencies), async published() { const result = await resources.files.listFiles({ scopeId: "session" }); if (result.type !== "page") throw new Error(result.message); return result.page.files; } };
}

describe("Node OpenAI immutable output publication", () => {
  it("reports failed publication explicitly without rejecting an already committed execution", async () => {
    const f = await fixture();
    const failure = new Error("Immutable output storage unavailable");
    f.sandbox.readFileBytes.mockRejectedValue(failure);
    const report = vi.fn();
    await expect(withReportedArtifactPublication(f.publish, report)(f.input)).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledExactlyOnceWith(failure, f.input);
    expect(await f.published()).toEqual([]);
    await expect(f.publish(f.input)).rejects.toBe(failure);
  });

  it("copies completed-turn binary bytes with exact execution provenance and skips repeated hooks after reconstruction", async () => {
    const f = await fixture();
    await f.publish(f.input);
    const [file] = await f.published();
    expect(file).toMatchObject({ origin: { type: "session_output", sessionId: "session", environmentId: "oai_env_session", turnId: "turn_session:root:sevt_input", path: "/workspace/outputs/report.bin" }, sizeBytes: 4 });
    f.bytes.fill(42);
    await createNodeOpenAIArtifactPublisher(f.dependencies)(f.input);
    expect(await f.published()).toHaveLength(1);
    expect(await f.files.downloadFile({ fileId: file!.id })).toMatchObject({ type: "found", file: { content: new Uint8Array([0, 1, 127, 255]) } });
    expect(f.sandbox.readFileBytes).toHaveBeenCalledTimes(1);
  });

  it("publishes exactly a.txt and steered s.txt on A, only b.txt on B, and changed bytes on C across reconstruction", async () => {
    const f = await fixture();
    const content = new Map([['a.txt', 'ARTIFACT_A_523'], ['s.txt', 'ARTIFACT_S_523']]);
    f.sandbox.exec.mockImplementation(async () => Buffer.from([...content.keys()].map(path => `./outputs/${path}\0`).join('')).toString('base64'));
    f.sandbox.readFileBytes.mockImplementation(async (...args: unknown[]) => new TextEncoder().encode(content.get(String(args[0]).split('/').at(-1)!)));
    f.facts.splice(2, 0, { executionId: 'S', consumedByExecutionId: f.executionId,
      event: { id: 'S', type: 'user.message', content: [{ type: 'text', text: 'write s.txt' }] } });
    const next = (id: string) => {
      f.facts.push({ executionId: id, consumedByExecutionId: id, event: { id, type: 'user.message', content: [{ type: 'text', text: id }] } },
        { executionId: id, event: { id: `${id}-run`, type: 'session.status_running' } },
        { executionId: id, event: { id: `${id}-idle`, type: 'session.status_idle', stopReason: { type: 'end_turn' } } });
      return createNodeOpenAIArtifactPublisher(f.dependencies)(f.fence(id));
    };
    await f.publish(f.input);
    expect(await f.published()).toHaveLength(2);
    content.set('b.txt', 'ARTIFACT_B_523');
    await next('B');
    const three = await f.published();
    expect(three).toHaveLength(3);
    expect(three.find(file => file.origin?.path.endsWith('/a.txt'))?.origin?.turnId).toBe('turn_session:root:sevt_input');
    expect(three.find(file => file.origin?.path.endsWith('/s.txt'))?.origin?.turnId).toBe('turn_session:root:sevt_input');
    expect(three.find(file => file.origin?.path.endsWith('/b.txt'))?.origin?.turnId).toBe('turn_session:root:B');
    await createNodeOpenAIArtifactPublisher(f.dependencies)(f.fence('B'));
    expect(await f.published()).toEqual(three);
    content.set('a.txt', 'CHANGED_A');
    await next('C');
    const four = await f.published();
    expect(four).toHaveLength(4);
    const changed = four.find(file => file.origin?.turnId === 'turn_session:root:C')!;
    expect(changed.origin).toMatchObject({ path: '/workspace/outputs/a.txt', contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await f.files.downloadFile({ fileId: changed.id })).toMatchObject({ file: { content: new TextEncoder().encode('CHANGED_A') } });
    content.set('a.txt', 'ARTIFACT_A_523');
    await next('D');
    expect(await f.published()).toEqual(four); // Historical content at the same path stays deduplicated.
  });

  it("deduplicates older Files without hashes using their persisted bytes", async () => {
    const f = await fixture();
    await f.files.uploadFile({ filename: 'report.bin', mimeType: 'application/octet-stream', content: f.bytes,
      origin: { type: 'session_output', sessionId: 'session', environmentId: 'old-env', turnId: 'old-turn', path: '/workspace/outputs/report.bin' } });
    await f.publish(f.input);
    expect(await f.published()).toHaveLength(1);
    expect((await f.published())[0].origin?.turnId).toBe('old-turn');
  });

  it("publishes outputs of the bootstrap execution, whose id is the bootstrap input event id", async () => {
    const f = await fixture("completed", "openai_hosted", "bootstrap");
    await f.publish(f.input);
    expect(await f.published()).toMatchObject([{ origin: { type: "session_output", turnId: `turn_session:root:${encodeURIComponent("bootstrap_session:0")}`, path: "/workspace/outputs/report.bin" } }]);
    expect(f.skipped()).toEqual([]);
  });

  it.each([
    ["user.define_outcome", "bootstrap_after_outcome", "bootstrap_session:0"],
    ["system.message", "bootstrap_after_system", "bootstrap_session:1"],
  ] as const)("publishes bootstrap outputs when bootstrap event 0 is %s", async (_type, round, executionId) => {
    const f = await fixture("completed", "openai_hosted", round);
    expect(f.executionId).toBe(executionId);
    await f.publish(f.input);
    expect(await f.published()).toMatchObject([{ origin: { type: "session_output", turnId: `turn_session:root:${encodeURIComponent("bootstrap_session:1")}`, path: "/workspace/outputs/report.bin" } }]);
    expect(f.skipped()).toEqual([]);
  });

  it.each(["cancelled", "failed", "requires_action"])("publishes nothing for %s even though a native idle fact was committed", async mode => {
    const f = await fixture(mode); await f.publish(f.input);
    expect(await f.published()).toEqual([]); expect(f.sandbox.exec).not.toHaveBeenCalled();
    expect(f.skipped()).toEqual(["turn_not_completed"]);
  });

  it.each(["none", "self_hosted"])("does not access an output filesystem for %s", async type => {
    const f = await fixture("completed", type); await f.publish(f.input);
    expect(await f.published()).toEqual([]); expect(f.sandbox.exec).not.toHaveBeenCalled();
    expect(f.skipped()).toEqual(["environment_not_openai_hosted"]);
  });

  it("does not assign a later completed turn to an older waiting execution", async () => {
    const f = await fixture("requires_action");
    f.facts.push({ event: { id: "result", type: "user.custom_tool_result", customToolUseId: "call", content: [{ type: "text", text: "done" }] } }, { executionId: "result", event: { id: "later-running", type: "session.status_running" } }, { executionId: "result", event: { id: "later-idle", type: "session.status_idle", stopReason: { type: "end_turn" } } });
    await f.publish(f.input);
    expect(await f.published()).toEqual([]);
    expect(f.sandbox.exec).not.toHaveBeenCalled();
    expect(f.skipped()).toEqual(["turn_not_completed_by_execution"]);
  });

  it("publishes a custom tool result resume into the original waiting turn", async () => {
    const f = await fixture("requires_action");
    f.facts.push({ event: { id: "result", type: "user.custom_tool_result", customToolUseId: "call", content: [{ type: "text", text: "done" }] } }, { executionId: "result", event: { id: "later-running", type: "session.status_running" } }, { executionId: "result", event: { id: "later-idle", type: "session.status_idle", stopReason: { type: "end_turn" } } });
    await f.publish(f.fence("result"));
    expect(await f.published()).toMatchObject([{ origin: { turnId: "turn_session:root:sevt_input", path: "/workspace/outputs/report.bin" } }]);
  });

  it("publishes an execution started by a tool confirmation into the lane's current turn", async () => {
    const f = await fixture("tool_confirmation");
    f.facts.push({ event: { id: "confirm", type: "user.tool_confirmation", toolUseId: "bash", result: "allow" } }, { executionId: "confirm", event: { id: "later-running", type: "session.status_running" } }, { executionId: "confirm", event: { id: "bash-result", type: "agent.tool_result", toolUseId: "bash", content: [{ type: "text", text: "" }] } }, { executionId: "confirm", event: { id: "later-idle", type: "session.status_idle", stopReason: { type: "end_turn" } } });
    await f.publish(f.fence("confirm"));
    expect(await f.published()).toMatchObject([{ origin: { turnId: "turn_session:root:sevt_input" } }]);
  });

  const openChild = (f: Awaited<ReturnType<typeof fixture>>) => {
    // The root execution opens the child thread before it goes idle.
    f.facts.splice(f.facts.findIndex(row => row.event.id === "idle"), 0, { executionId: f.executionId, event: { id: "child-open", type: "session.thread_created", sessionThreadId: "sthr_child", agentName: "helper" } });
    f.facts.push(
      { event: { id: "child_input", type: "agent.thread_message_received", sessionThreadId: "sthr_child", fromSessionThreadId: "sthr_primary", content: [{ type: "text", text: "go" }] } },
      { executionId: "child_input", event: { id: "child-running", type: "session.thread_status_running", sessionThreadId: "sthr_child" } },
      { executionId: "child_input", event: { id: "child-idle", type: "session.thread_status_idle", sessionThreadId: "sthr_child", stopReason: { type: "end_turn" } } },
    );
  };

  it("does not attribute a subagent execution to the root lane and logs it below warn", async () => {
    const f = await fixture();
    openChild(f);
    await f.publish(f.fence("child_input"));
    expect(await f.published()).toEqual([]);
    expect(f.sandbox.exec).not.toHaveBeenCalled();
    expect(f.skipped()).toEqual(["execution_not_root_lane"]);
    expect(f.logger.info).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "execution_not_root_lane", laneId: "sthr_child", executionId: "child_input" }), expect.any(String));
    expect(f.logger.warn).not.toHaveBeenCalled();
  });

  it("does not publish to root for a subagent execution that also commits root-lane facts", async () => {
    const f = await fixture();
    openChild(f);
    // The child's reply lands on the primary lane under the child's execution.
    f.facts.push({ executionId: "child_input", event: { id: "child-reply", type: "agent.thread_message_received", sessionThreadId: "sthr_primary", fromSessionThreadId: "sthr_child", content: [{ type: "text", text: "done" }] } });
    await f.publish(f.fence("child_input"));
    expect(await f.published()).toEqual([]);
    expect(f.sandbox.exec).not.toHaveBeenCalled();
    expect(f.skipped()).toEqual(["execution_not_root_lane"]);
  });

  it("still publishes the root execution that opened a subagent thread", async () => {
    const f = await fixture();
    openChild(f);
    await f.publish(f.input);
    expect(await f.published()).toMatchObject([{ origin: { turnId: "turn_session:root:sevt_input" } }]);
    expect(f.skipped()).toEqual([]);
  });

  it("warns only for an execution that resolves to no turn", async () => {
    const f = await fixture();
    await f.publish(f.fence("unknown_execution"));
    expect(await f.published()).toEqual([]);
    expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "execution_turn_not_found", executionId: "unknown_execution" }), expect.any(String));
  });

  it("rejects publication after loss of execution ownership before writing any bytes", async () => {
    const f = await fixture(); f.isFenceActive.mockResolvedValue(false);
    await expect(f.publish(f.input)).rejects.toThrow(/fence/i);
    expect(await f.published()).toEqual([]);
  });

  it("serializes concurrent hook invocations and persists one immutable snapshot", async () => {
    const f = await fixture();
    await Promise.all([f.publish(f.input), f.publish(f.input)]);
    expect(await f.published()).toHaveLength(1);
    expect(f.sandbox.readFileBytes).toHaveBeenCalledTimes(1);
  });

  it("rejects an output manifest escaping the public output directory", async () => {
    const f = await fixture();
    f.sandbox.exec.mockResolvedValue(Buffer.from("./outputs/../private.bin\0").toString("base64"));
    await expect(f.publish(f.input)).rejects.toThrow(/escaped/);
    expect(await f.published()).toEqual([]);
    expect(f.sandbox.readFileBytes).not.toHaveBeenCalled();
  });
});
