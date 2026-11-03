// @openma/server: the composition facade for a Node control plane (ADR 0015).
//
//   import { createApp, nodeDefaults, managedAgentsPortTokens } from "@openma/server";
//   const app = createApp({ modules: nodeDefaults({ workspaceId, stores: { agents: myStore } }) });
//   await app.start();
//   const agents = app.port(managedAgentsPortTokens.agents);
//
// Port and domain types come from @openma/core; store adapters from
// @openma/stores-memory and @openma/stores-sql. Module factories and outbound
// Port tokens are in @openma/server/modules.
export {
  AppCompositionError,
  AppLifecycleError,
  bindPort,
  createApp,
  createPortToken,
  defineAppModule,
  providePort,
  type App,
  type AppCompositionErrorCode,
  type AppModule,
  type AppModuleContext,
  type AppModuleInstance,
  type AppPortBinding,
  type AppStatus,
  type CreateAppOptions,
  type PortToken,
  type ProvidePortOptions,
} from "@open-managed-agents/app";
export {
  createManagedAgentsApp,
  managedAgentsApplicationPortsModule,
  managedAgentsApplicationPortsToken,
  managedAgentsPortTokens,
  type CreateManagedAgentsAppOptions,
  type ManagedAgentsApp,
} from "@open-managed-agents/app/managed-agents";
export {
  managedAgentsFeatureModules,
  type ManagedAgentsFeature,
  type ManagedAgentsFeatureSetting,
  type ManagedAgentsFeatures,
} from "@open-managed-agents/app/features";
export {
  clockPort,
  httpClientPort,
  idGeneratorPort,
  workspaceContextPort,
  type ClockPort,
  type HttpClientPort,
  type IdGeneratorPort,
  type WorkspaceContextPort,
} from "@open-managed-agents/app/capabilities";
export {
  resolveWorkspaceValue,
  WorkspaceAppRegistry,
  type WorkspaceAppRegistryOptions,
  type WorkspaceScope,
  type WorkspaceValue,
} from "@open-managed-agents/platform";
export {
  createNodeManagedAgentsApp,
  createNodePlatform,
  nodeDefaults,
  type CreateNodeManagedAgentsAppOptions,
  type CreateNodePlatformOptions,
  type NodeAdmissionHooks,
  type NodeDefaultsOptions,
  type NodePlatform,
} from "@open-managed-agents/platform-node";
// Admission: the shared create policy (rate limit, daily cap, host hook) and
// the admit-all defaults `nodeDefaults()` binds when no hook is passed.
export {
  admitAllSessionCreates,
  admitAllSessionWork,
  SessionCreateAdmissionService,
  type SessionCreateAdmissionLogger,
  type SessionCreateAdmissionServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
