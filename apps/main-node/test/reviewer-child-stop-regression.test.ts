import { describe, expect, it } from "vitest";
import type { HarnessContext } from "@open-managed-agents/agent-harness";
import type { Environment, Session, SessionEventView } from "@open-managed-agents/managed-agents-application";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { decodeRuntimeProducedSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { MemorySessionThreadStore } from "../../../packages/session-thread-store-memory/src/index";
import { DefaultNodeManagedSessionRunner, type DefaultNodeManagedSessionRunnerDependencies } from "../../../packages/control-plane-node/src/lib/node-managed-session-runner";
import { resolveManagedSubagentSession, type ManagedNodeSubagentControl } from "../../../packages/control-plane-node/src/lib/node-managed-subagents";
import { nodeOpenAISubagentPolicy } from "../../../packages/control-plane-node/src/openai-subagents";
import type { ManagedNodeHarnessRuntime } from "../../../packages/control-plane-node/src/lib/node-managed-harness-runtime";

const session: Session = {
  id: "session_children", agent: { id: "parent", description: null, mcpServers: [],
    model: { id: "local-model" }, multiagent: null, name: "Parent", skills: [],
    system: "Parent instructions", tools: [], version: 1 }, archivedAt: null, budget: null,
  createdAt: "2026-09-11T00:00:00Z", environmentId: "env", metadata: {},
  outcomeEvaluations: [], resources: [], stats: {}, status: "running", title: null,
  updatedAt: "2026-09-11T00:00:00Z", usage: {}, vaultIds: [],
};
const environment: Environment = { id: "env", config: { type: "self_hosted" },
  archivedAt: null, createdAt: session.createdAt, updatedAt: session.updatedAt,
  name: "Shared", description: null, metadata: {} };

type Context = {
  session: Session;
  runtime: ManagedNodeHarnessRuntime;
  sandbox: SandboxExecutor;
  subagents?: ManagedNodeSubagentControl;
};

function fixture(run: (context: Context) => Promise<void>, store = new MemorySessionThreadStore(), options: {
  maxConcurrentSubagents?: number;
  native?: boolean;
  output?(frame: Record<string, unknown>): Promise<void>;
} = {}) {
  const activeSession = structuredClone(session);
  if (options.native) activeSession.agent.multiagent = { type: "multiagent_20261001", advisor: { type: "disabled" }, workflows: { type: "disabled" }, subagents: { type: "enabled", inlineAgents: { type: "enabled" }, predefinedAgents: [] } };
  const frames: Record<string, unknown>[] = [];
  const sandbox = { exec: async () => ({ stdout: "shared", stderr: "", exitCode: 0 }) } as unknown as SandboxExecutor;
  let id = 0;
  const deps: DefaultNodeManagedSessionRunnerDependencies = {
    buildSandbox: async () => sandbox,
    buildModel: async () => ({}) as HarnessContext["model"],
    buildTools: async () => ({}),
    buildHarnessContext: async (input) => input as unknown as HarnessContext,
    buildHarness: () => ({ run: async (context) => run(context as unknown as Context) }),
    confirmedTools: { execute: async () => { throw new Error("Unexpected confirmed tool"); } },
    outcomes: { evaluate: async () => { throw new Error("Unexpected outcome"); } },
    clock: { now: () => new Date("2026-09-11T00:00:00Z") },
    ids: { nextEventId: () => `event_${++id}` },
    subagentThreads: store,
    subagentPolicy: options.native ? ({ session }) => nodeOpenAISubagentPolicy(session, {} as never) : () => ({ enabled: true, maxConcurrentSubagents: options.maxConcurrentSubagents ?? 2 }),
    ...(options.native && { resolveSubagentSession: async ({ session, request }) => resolveManagedSubagentSession(session, request) }),
  };
  const runner = new DefaultNodeManagedSessionRunner(deps);
  return {
    runner, sandbox, frames, store,
    async run(history: SessionEventView[] = []) {
      await runner.start({ workspaceId: "workspace", sessionId: session.id, session: activeSession, environment, initialEvents: [] });
      const message = { id: `input_${++id}`, type: "user.message" as const,
        content: [{ type: "text" as const, text: "Parent task" }], processedAt: session.createdAt };
      await runner.accept({ workspaceId: "workspace", sessionId: session.id, session: activeSession, environment,
        initialEvents: [], historyEvents: [...history, message], events: [message],
        output: async (frame) => { frames.push(frame as Record<string, unknown>); await options.output?.(frame as Record<string, unknown>); } });
    },
  };
}



it('completed child stop is not overwritten by sibling shared budget exhaustion',async()=>{const {createSessionBudgetGate,memoryListCostPicoStore}=await import('../../../packages/agent-harness/src/budget');const gate=createSessionBudgetGate({amount:'1',currency:'USD'},{version:1,currency:'USD',input_per_mtok:'1',output_per_mtok:'1'},memoryListCostPicoStore('0'))!;let fastId='',ready!:()=>void,exhausted!:()=>void;const completed=new Promise<void>(r=>ready=r),charged=new Promise<void>(r=>exhausted=r);const f=fixture(async({session:active,runtime,subagents})=>{if(active.agent.name==='Parent'){subagents!.setBudgetGate!(gate);fastId=(await subagents!.create({name:'Fast',message:'Work'})).threadId;const second=await subagents!.create({name:'Expensive',message:'Work'});await subagents!.wait({threadIds:[fastId,second.threadId]})}else if(active.agent.name==='Fast'){runtime.broadcast({type:'agent.message',content:[{type:'text',text:'completed normally'}]});runtime.broadcast({type:'session.status_idle',stop_reason:{type:'end_turn'}} as any);ready();await charged}else{await completed;gate.reached=true;exhausted()}});await f.run();const idle=f.frames.filter(x=>x.type==='session.thread_status_idle'&&x.session_thread_id===fastId);expect(idle.at(-1)).toMatchObject({stop_reason:{type:'end_turn'}})});
