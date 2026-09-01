import {
  SkillsApplicationService,
  SkillVersionsApplicationService,
  type SkillPackageCompilerPort,
} from "@open-managed-agents/managed-agents-application";
import type { SkillStore } from "@open-managed-agents/skill-store";

import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../capabilities";
import {
  bindPort,
  createPortToken,
  defineAppModule,
  type AppModule,
} from "../index";
import { managedAgentsPortTokens } from "../managed-agents";

export const skillStorePort = createPortToken<SkillStore>(
  "managed-agents.store.skills",
);

export const skillPackageCompilerPort =
  createPortToken<SkillPackageCompilerPort>(
    "managed-agents.outbound.skills.package-compiler",
  );

export function skillsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:skills",
    provides: [managedAgentsPortTokens.skills],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      skillStorePort,
      skillPackageCompilerPort,
    ],
    setup({ port }) {
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.skills,
          new SkillsApplicationService({
            workspaceId: port(workspaceContextPort).workspaceId,
            store: port(skillStorePort),
            compiler: port(skillPackageCompilerPort),
            clock: port(clockPort),
            ids: {
              nextSkillId: () => ids.next("skill"),
              nextSkillVersionId: () => ids.next("skill-version"),
              nextSkillVersion: () => ids.next("skill-version-value"),
            },
          }),
        )],
      };
    },
  });
}

export function skillVersionsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:skill-versions",
    provides: [managedAgentsPortTokens.skillVersions],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      skillStorePort,
      skillPackageCompilerPort,
    ],
    setup({ port }) {
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.skillVersions,
          new SkillVersionsApplicationService({
            workspaceId: port(workspaceContextPort).workspaceId,
            store: port(skillStorePort),
            compiler: port(skillPackageCompilerPort),
            clock: port(clockPort),
            ids: {
              nextSkillVersionId: () => ids.next("skill-version"),
              nextSkillVersion: () => ids.next("skill-version-value"),
            },
          }),
        )],
      };
    },
  });
}
