// Id minting for the Node managed platform. One generator serves every
// official application module; the prefix table is the public shape of ids
// stored in operators' databases and must not change casually.

import { nanoid } from "nanoid";

import type { IdGeneratorPort } from "@open-managed-agents/app/capabilities";

export const managedIdPrefixes: Readonly<Record<string, string>> = {
  agent: "agent",
  environment: "env",
  file: "file",
  memory_store: "memstore",
  "user-profile": "uprof",
  "environment-work": "work",
  deployment: "depl",
  "deployment-run": "drun",
  dream: "dream",
  memory: "mem",
  "memory-version": "memver",
  tunnel: "tnl",
  "tunnel-certificate": "tcrt",
  skill: "skill",
  "skill-version": "skv",
  credential: "vcrd",
  vault: "vlt",
};

/** Skill version values are not ids: they are strictly increasing microsecond timestamps. */
const skillVersionValueNamespace = "skill-version-value";

export function createManagedIdGenerator(
  options: { now?: () => number } = {},
): IdGeneratorPort {
  const now = options.now ?? Date.now;
  let lastSkillVersion = 0n;
  return {
    next(namespace: string): string {
      if (namespace === skillVersionValueNamespace) {
        const candidate = BigInt(now()) * 1_000n;
        lastSkillVersion = candidate > lastSkillVersion ? candidate : lastSkillVersion + 1n;
        return lastSkillVersion.toString();
      }
      return `${managedIdPrefixes[namespace] ?? namespace}_${nanoid()}`;
    },
  };
}
