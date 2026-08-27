import type { SkillStore } from "@open-managed-agents/skill-store";
import type {
  SkillsApplicationServiceDependencies,
  SkillVersionsApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import { skillStorePort } from "@open-managed-agents/app/modules/skills";

/** The structural shape implemented by v0 Skill persistence adapters. */
export type V0SkillPersistence = SkillStore;

export type V0SkillsApplicationServiceDependencies = Omit<
  SkillsApplicationServiceDependencies,
  "store"
> & { persistence: V0SkillPersistence };

export type V0SkillVersionsApplicationServiceDependencies = Omit<
  SkillVersionsApplicationServiceDependencies,
  "store"
> & { persistence: V0SkillPersistence };

export function skillStoreFromV0(
  persistence: V0SkillPersistence,
): SkillStore {
  return persistence;
}

export function skillsDependenciesFromV0(
  dependencies: V0SkillsApplicationServiceDependencies,
): SkillsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: skillStoreFromV0(persistence) };
}

export function skillVersionsDependenciesFromV0(
  dependencies: V0SkillVersionsApplicationServiceDependencies,
): SkillVersionsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: skillStoreFromV0(persistence) };
}

export function v0SkillPersistenceModule(
  persistence: V0SkillPersistence,
): AppModule {
  return providePort(skillStorePort, skillStoreFromV0(persistence), {
    name: "compat-v0:skill-persistence",
  });
}
