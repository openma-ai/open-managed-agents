import type { AgentStore } from "@open-managed-agents/agent-store";
import type {
  AgentsApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import {
  providePort,
  type AppModule,
} from "@open-managed-agents/app";
import { agentStorePort } from "@open-managed-agents/app/modules/agents";

/** The structural shape implemented by v0 Agent persistence adapters. */
export type V0AgentPersistence = AgentStore;

export type V0AgentsApplicationServiceDependencies = Omit<
  AgentsApplicationServiceDependencies,
  "store"
> & {
  persistence: V0AgentPersistence;
};

/**
 * Adapts a v0 Agent persistence implementation to the v1 AgentStore Port.
 * The shapes are compatible, so the adapter preserves object identity.
 */
export function agentStoreFromV0(
  persistence: V0AgentPersistence,
): AgentStore {
  return persistence;
}

/** Renames the v0 constructor dependency without changing its implementation. */
export function agentsDependenciesFromV0(
  dependencies: V0AgentsApplicationServiceDependencies,
): AgentsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: agentStoreFromV0(persistence) };
}

/** Installs a v0 Agent persistence implementation into a v1 app graph. */
export function v0AgentPersistenceModule(
  persistence: V0AgentPersistence,
): AppModule {
  return providePort(agentStorePort, agentStoreFromV0(persistence), {
    name: "compat-v0:agent-persistence",
  });
}
