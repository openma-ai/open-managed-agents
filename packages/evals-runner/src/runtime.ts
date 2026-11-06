// The runtime port the eval runner drives. Both runtimes implement it with
// the same managed-agents application ports (createManagedEvalRuntime); only
// sandbox exec and "start the sandbox without a turn" are runtime-specific:
// Node talks to its in-process runner, Cloudflare to the Session's SessionDO.

import type {
  AgentsApplicationPort,
  EnvironmentsApplicationPort,
  SessionEventsApplicationPort,
  SessionsApplicationPort,
} from "@open-managed-agents/managed-agents-application";

export interface EvalExecResult {
  exit_code: number;
  output: string;
}

export type EvalSessionSettlement =
  | { settled: false }
  | { settled: true; stopReason: string | null };

export interface EvalSessionRuntime {
  /** Current, unarchived managed agent. */
  agentExists(agentId: string): Promise<boolean>;
  /** Managed environment exists and is not archived. */
  environmentExists(environmentId: string): Promise<boolean>;
  /** Why this deployment cannot run eval Sessions in an existing environment,
   * or null when it can. Absent means every environment is supported. */
  environmentProblem?(environmentId: string): Promise<string | null>;
  /** Agent and environment configuration recorded in a trajectory. */
  trajectoryConfigs(agentId: string, environmentId: string): Promise<{ agent: Record<string, unknown>; environment: Record<string, unknown> }>;
  /** The hidden agent that owns oracle-mode Sessions (never sent a message). */
  oracleAgentId(): Promise<string>;
  /** Find or create the cloud environment that selects this SANDBOX_IMAGES alias. */
  environmentForImage(alias: string): Promise<string>;
  createSession(input: { agentId: string; environmentId: string; title: string; metadata: Record<string, string> }): Promise<string>;
  /** Returns the accepted user.message event id. */
  sendUserMessage(sessionId: string, text: string): Promise<string>;
  interrupt(sessionId: string): Promise<void>;
  /** Did the turn started by `messageEventId` end (idle that is not a
   *  requires_action pause counts; so does termination)? */
  settledAfter(sessionId: string, messageEventId: string): Promise<EvalSessionSettlement>;
  /** All events, oldest first (trajectory building). */
  listEvents(sessionId: string): Promise<Array<{ id: string; type: string; processedAt?: string | null } & Record<string, unknown>>>;
  /** Session status, null when it does not exist. */
  status(sessionId: string): Promise<string | null>;
  /** Run a shell command in the Session sandbox; stderr merged into output. */
  exec(sessionId: string, command: string, timeoutMs: number): Promise<EvalExecResult>;
  /** Make sure the Session has a sandbox although no turn has run (oracle
   *  mode, setup files). Returns false while it is still starting. */
  ensureSandbox(sessionId: string): Promise<boolean>;
  /** Free the sandbox after a trial is graded; the Session stays readable. */
  releaseSandbox(sessionId: string): Promise<void>;
  /** SANDBOX_IMAGES alias whose reference equals `image`, or null. */
  imageAlias(image: string): string | null;
}

export class EvalRuntimeError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "EvalRuntimeError";
  }
}

export interface ManagedEvalRuntimeDependencies {
  agents: AgentsApplicationPort;
  environments: EnvironmentsApplicationPort;
  sessions: SessionsApplicationPort;
  sessionEvents: SessionEventsApplicationPort;
  /** Operator SANDBOX_IMAGES entries (alias + provider reference). */
  images: ReadonlyArray<{ alias: string; reference: string }>;
  exec(sessionId: string, command: string, timeoutMs: number): Promise<EvalExecResult>;
  ensureSandbox(sessionId: string): Promise<boolean>;
  releaseSandbox?(sessionId: string): Promise<void>;
  /** Reject self-hosted environments with this reason (eval Sessions are
   * created by a background tick that has no API origin to hand them). */
  selfHostedUnsupported?: string;
}

const EVAL_IMAGE_METADATA = "oma_eval_image";
const EVAL_ROLE_METADATA = "oma_eval_role";

function field(event: object, camel: string, snake: string): unknown {
  const record = event as Record<string, unknown>;
  return record[camel] ?? record[snake];
}

export function createManagedEvalRuntime(deps: ManagedEvalRuntimeDependencies): EvalSessionRuntime {
  const environmentIds = new Map<string, Promise<string>>();
  let oracleAgent: Promise<string> | null = null;

  const findOrCreateEnvironment = async (alias: string): Promise<string> => {
    let cursor: string | undefined;
    for (;;) {
      const page = await deps.environments.listEnvironments({ pageSize: 100, ...(cursor ? { cursor } : {}) });
      if (page.type !== "page") throw new EvalRuntimeError(page.message);
      const match = page.page.environments.find((environment) =>
        environment.archivedAt === null
        && environment.metadata[EVAL_IMAGE_METADATA] === alias
        && environment.openma?.sandboxImage === alias);
      if (match) return match.id;
      if (page.page.nextCursor === null) break;
      cursor = page.page.nextCursor;
    }
    const created = await deps.environments.createEnvironment({
      name: `oma-eval-${alias}`,
      description: "Created by OMA evals for Harbor tasks using this sandbox image.",
      config: { type: "cloud", networking: { type: "unrestricted" } },
      metadata: { [EVAL_IMAGE_METADATA]: alias },
      openma: { sandboxImage: alias },
    });
    if (created.type !== "created") throw new EvalRuntimeError(`Creating the eval environment for ${alias} failed: ${created.message}`);
    return created.environment.id;
  };

  const findOrCreateOracleAgent = async (): Promise<string> => {
    let cursor: string | undefined;
    for (;;) {
      const page = await deps.agents.listAgents({ pageSize: 100, ...(cursor ? { cursor } : {}) });
      if (page.type !== "page") throw new EvalRuntimeError(page.message);
      const match = page.page.agents.find((agent) =>
        (agent as { archivedAt?: string | null }).archivedAt == null
        && (agent as { metadata?: Record<string, string> }).metadata?.[EVAL_ROLE_METADATA] === "oracle");
      if (match) return match.id;
      if (page.page.nextCursor === null) break;
      cursor = page.page.nextCursor;
    }
    const created = await deps.agents.createAgent({
      name: "OMA eval oracle",
      description: "Hosts Harbor oracle trials (solution/solve.sh). It is never sent a message.",
      model: "claude-sonnet-4-6",
      system: "This agent only owns evaluation Sessions; it never runs.",
      metadata: { [EVAL_ROLE_METADATA]: "oracle" },
    });
    if (created.type !== "created") throw new EvalRuntimeError(`Creating the eval oracle agent failed: ${(created as { message?: string }).message ?? created.type}`);
    return created.agent.id;
  };

  return {
    async agentExists(agentId) {
      const found = await deps.agents.retrieveAgent({ agentId });
      return found.type === "found" && (found.agent as { archivedAt?: string | null }).archivedAt == null;
    },
    async environmentExists(environmentId) {
      const found = await deps.environments.retrieveEnvironment({ environmentId });
      return found.type === "found" && found.environment.archivedAt === null;
    },
    async trajectoryConfigs(agentId, environmentId) {
      const [agent, environment] = await Promise.all([
        deps.agents.retrieveAgent({ agentId }),
        deps.environments.retrieveEnvironment({ environmentId }),
      ]);
      if (agent.type !== "found") throw new EvalRuntimeError(`Agent ${agentId} not found`);
      if (environment.type !== "found") throw new EvalRuntimeError(`Environment ${environmentId} not found`);
      return {
        agent: agent.agent as unknown as Record<string, unknown>,
        environment: environment.environment as unknown as Record<string, unknown>,
      };
    },
    async environmentProblem(environmentId) {
      if (deps.selfHostedUnsupported === undefined) return null;
      const found = await deps.environments.retrieveEnvironment({ environmentId });
      return found.type === "found" && found.environment.config.type === "self_hosted"
        ? deps.selfHostedUnsupported
        : null;
    },
    oracleAgentId() {
      oracleAgent ??= findOrCreateOracleAgent().catch((error) => { oracleAgent = null; throw error; });
      return oracleAgent;
    },
    environmentForImage(alias) {
      let pending = environmentIds.get(alias);
      if (pending === undefined) {
        pending = findOrCreateEnvironment(alias).catch((error) => { environmentIds.delete(alias); throw error; });
        environmentIds.set(alias, pending);
      }
      return pending;
    },
    async createSession(input) {
      const created = await deps.sessions.createSession({
        agent: { type: "latest", agentId: input.agentId },
        environmentId: input.environmentId,
        title: input.title,
        metadata: input.metadata,
      });
      if (created.type === "created") return created.session.id;
      // Quota / rate limits clear on their own; retry on a later tick.
      throw new EvalRuntimeError(`Creating the Session failed (${created.type}): ${created.message}`, created.type === "rate_limited");
    },
    async sendUserMessage(sessionId, text) {
      const sent = await deps.sessionEvents.sendSessionEvents({
        sessionId,
        events: [{ type: "user.message", content: [{ type: "text", text }] } as never],
      });
      if (sent.type !== "accepted") {
        throw new EvalRuntimeError(`Sending the task message failed (${sent.type})${"message" in sent ? `: ${sent.message}` : ""}`);
      }
      const id = sent.events?.find((event) => event.type === "user.message")?.id;
      if (!id) throw new EvalRuntimeError("user.message was accepted without an event id");
      return id;
    },
    async interrupt(sessionId) {
      const sent = await deps.sessionEvents.sendSessionEvents({ sessionId, events: [{ type: "user.interrupt" } as never] });
      if (sent.type !== "accepted" && sent.type !== "not_found") {
        throw new EvalRuntimeError(`Interrupting the Session failed (${sent.type})`);
      }
    },
    async settledAfter(sessionId, messageEventId) {
      // Newest first: stop once we reach our own message.
      let cursor: string | undefined;
      for (;;) {
        const page = await deps.sessionEvents.listSessionEvents({ sessionId, order: "desc", pageSize: 200, ...(cursor ? { cursor } : {}) });
        if (page.type === "not_found") return { settled: true, stopReason: "session_not_found" };
        if (page.type !== "page") throw new EvalRuntimeError(page.message);
        for (const event of page.page.events) {
          if (event.id === messageEventId) return { settled: false };
          if (event.type === "session.status_terminated") return { settled: true, stopReason: "terminated" };
          if (event.type === "session.status_idle") {
            const stop = field(event, "stopReason", "stop_reason") as { type?: string } | undefined;
            return { settled: true, stopReason: stop?.type ?? null };
          }
        }
        if (page.page.nextCursor === null) return { settled: false };
        cursor = page.page.nextCursor;
      }
    },
    async listEvents(sessionId) {
      const events: Array<{ id: string; type: string } & Record<string, unknown>> = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await deps.sessionEvents.listSessionEvents({ sessionId, order: "asc", pageSize: 1000, ...(cursor ? { cursor } : {}) });
        if (page.type !== "page") throw new EvalRuntimeError(page.type === "not_found" ? "Session not found" : page.message);
        events.push(...(page.page.events as unknown as Array<{ id: string; type: string } & Record<string, unknown>>));
        if (page.page.nextCursor === null) return events;
        cursor = page.page.nextCursor;
      }
    },
    async status(sessionId) {
      const found = await deps.sessions.retrieveSession({ sessionId });
      return found.type === "found" ? found.session.status : null;
    },
    exec: (sessionId, command, timeoutMs) => deps.exec(sessionId, command, timeoutMs),
    ensureSandbox: (sessionId) => deps.ensureSandbox(sessionId),
    releaseSandbox: async (sessionId) => { await deps.releaseSandbox?.(sessionId); },
    imageAlias(image) {
      return deps.images.find((entry) => entry.reference === image)?.alias ?? null;
    },
  };
}
