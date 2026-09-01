import { AppCompositionError, type AppModule } from "./index";
import { managedAgentsPortTokens } from "./managed-agents";
import { agentsModule } from "./modules/agents";
import { credentialsModule } from "./modules/credentials";
import { deploymentRunsModule } from "./modules/deployment-runs";
import { deploymentsModule } from "./modules/deployments";
import { dreamsModule } from "./modules/dreams";
import { environmentsModule } from "./modules/environments";
import { environmentWorkModule } from "./modules/environment-work";
import { filesModule } from "./modules/files";
import { memoriesModule, memoryVersionsModule } from "./modules/memories";
import { memoryStoresModule } from "./modules/memory-stores";
import { modelsModule } from "./modules/models";
import { sessionEventsModule } from "./modules/session-events";
import { sessionResourcesModule } from "./modules/session-resources";
import { sessionThreadEventsModule } from "./modules/session-thread-events";
import { sessionThreadsModule } from "./modules/session-threads";
import { sessionsModule } from "./modules/sessions";
import { skillsModule, skillVersionsModule } from "./modules/skills";
import {
  tunnelCertificatesModule,
  tunnelsModule,
} from "./modules/tunnels";
import { userProfilesModule } from "./modules/user-profiles";
import { vaultsModule } from "./modules/vaults";

const officialFeatureModules = {
  agents: agentsModule,
  credentials: credentialsModule,
  deploymentRuns: deploymentRunsModule,
  deployments: deploymentsModule,
  dreams: dreamsModule,
  environments: environmentsModule,
  environmentWork: environmentWorkModule,
  files: filesModule,
  memories: memoriesModule,
  memoryStores: memoryStoresModule,
  memoryVersions: memoryVersionsModule,
  models: modelsModule,
  sessionEvents: sessionEventsModule,
  sessionResources: sessionResourcesModule,
  sessionThreadEvents: sessionThreadEventsModule,
  sessionThreads: sessionThreadsModule,
  sessions: sessionsModule,
  skillVersions: skillVersionsModule,
  skills: skillsModule,
  tunnelCertificates: tunnelCertificatesModule,
  tunnels: tunnelsModule,
  userProfiles: userProfilesModule,
  vaults: vaultsModule,
} satisfies Record<keyof typeof managedAgentsPortTokens, () => AppModule>;

export type ManagedAgentsFeature = keyof typeof officialFeatureModules;

export type ManagedAgentsFeatureSetting = boolean | AppModule;

export type ManagedAgentsFeatures = {
  /** `core` is the default. `none` starts from an empty feature set. */
  preset?: "core" | "none";
} & Partial<Record<ManagedAgentsFeature, ManagedAgentsFeatureSetting>>;

const coreFeatures = new Set<ManagedAgentsFeature>([
  "agents",
  "deploymentRuns",
  "environments",
  "memoryStores",
  "vaults",
]);

/** Resolves official modules, explicit disable flags, and compatible replacements. */
export function managedAgentsFeatureModules(
  features: ManagedAgentsFeatures | false | undefined,
): AppModule[] {
  if (features === false) return [];
  const preset = features?.preset ?? "core";
  const modules: AppModule[] = [];
  for (const feature of Object.keys(officialFeatureModules) as ManagedAgentsFeature[]) {
    const setting = features?.[feature]
      ?? (preset === "core" && coreFeatures.has(feature));
    if (setting === false) continue;
    const module = setting === true
      ? officialFeatureModules[feature]()
      : setting;
    if (!module.provides.includes(managedAgentsPortTokens[feature])) {
      throw new AppCompositionError(
        "invalid_module",
        `Feature ${feature} replacement must provide Port ${managedAgentsPortTokens[feature].name}`,
      );
    }
    modules.push(module);
  }
  return modules;
}
