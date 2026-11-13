// Compatibility import path; control/history implementation is shared with desktop.
export * from "@openma/common/managed-runtime";
import {
  createManagedHarnessHttpSkillSource as concreteSkillSource,
  type ManagedHarnessHttpRecoveryHistoryOptions,
  type ManagedHarnessHttpSkillSource,
} from "@openma/common/managed-runtime";

/** The common transport downloads concrete versions. Session Skill selectors
 * may also be `latest`; resolve the published pointer through the same scoped
 * API before downloading. Extraction and model-visible paths remain owned by
 * the existing resource materializer. Never guess a version or fetch unscoped. */
export function createManagedHarnessHttpSkillSource(
  options: ManagedHarnessHttpRecoveryHistoryOptions,
): ManagedHarnessHttpSkillSource {
  const source = concreteSkillSource(options);
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async download(input) {
      if (input.version !== "latest") return source.download(input);
      options.signal?.throwIfAborted();
      const response = await fetcher(`${options.apiBaseUrl.replace(/\/+$/u, "")}/v1/skills/${encodeURIComponent(input.skillId)}`, {
        method: "GET", redirect: "error", signal: options.signal,
        headers: { authorization: `Bearer ${options.sessionsToken}` },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Skill latest-version resolution failed (${response.status})`);
      }
      const skill = await response.json() as { id?: unknown; latest_version_id?: unknown };
      if (skill.id !== input.skillId || typeof skill.latest_version_id !== "string" || !/^\d+$/u.test(skill.latest_version_id)) {
        throw new Error("Skill latest-version response has no concrete version");
      }
      options.signal?.throwIfAborted();
      return source.download({ ...input, version: skill.latest_version_id });
    },
  };
}
