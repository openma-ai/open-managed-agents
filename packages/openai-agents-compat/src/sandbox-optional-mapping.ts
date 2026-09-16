import type { EnvironmentsApplicationPort } from "@open-managed-agents/managed-agents-application/ports/environments";
import type { SessionView } from "@open-managed-agents/managed-agents-application/ports/sessions";
import { OpenAIAgentsProtocolError } from "@open-managed-agents/openai-agents-api";
import { toCoreEnvironmentConfig } from "./resource-mappers";
import { createSessionRuntimeEnvironmentMetadata } from "./resources";
import type { ManagedSessionMappingRuntime } from "./session-mapping";
import type { ResourceObject } from "./resource-types";

const unsupported = (param: string): never => { throw new OpenAIAgentsProtocolError(501, `The configured runtime cannot enact ${param}`, param, "unsupported_feature"); };
const hasValues = (value: unknown): boolean => value != null && typeof value === "object" && Object.values(value).some(item => Array.isArray(item) ? item.length > 0 : item != null);
const environmentId = (session: SessionView): string => `oai_env_${session.id}`;

/** Shared mapping for runtimes that implement environment:none without provisioning a sandbox. */
export function createSandboxOptionalSessionMapping(
  environments: EnvironmentsApplicationPort,
  options: { dynamicSubagents?: boolean } = {},
): ManagedSessionMappingRuntime {
  return {
    async assertAgentConfiguration(configuration, findings, environment) {
      const unavailable = findings.find(finding => !options.dynamicSubagents || finding.capability !== "dynamic_subagents");
      if (unavailable) unsupported(`agent.${unavailable.path}`);
      if (configuration.reasoning?.effort != null) unsupported("agent.reasoning.effort");
      if (configuration.service_tier !== "auto") unsupported("agent.service_tier");
      if (environment.type === "none") {
        const unsupportedTool = (configuration.tools ?? []).findIndex((tool: ResourceObject) => tool.type === "web_search" && tool.mode !== "disabled");
        if (unsupportedTool >= 0) unsupported(`agent.tools[${unsupportedTool}]`);
      }
    },
    async prepareEnvironment(configuration) {
      if (configuration.type === "self_hosted") unsupported("environment.type");
      if (configuration.type !== "none") {
        if (configuration.network?.access && configuration.network.access !== "enabled") unsupported("environment.network");
        if (hasValues(configuration.packages)) unsupported("environment.packages");
        for (const key of ["env", "setup_commands", "files", "plugins", "skills", "capability_directories"]) {
          if (hasValues(configuration[key])) unsupported(`environment.${key}`);
        }
      }
      // A native configuration relation is required by the Session aggregate.
      // The none runner hook never constructs or prepares a physical sandbox.
      const created = await environments.createEnvironment({ name: configuration.name ?? "Session runtime", config: toCoreEnvironmentConfig(configuration), metadata: createSessionRuntimeEnvironmentMetadata() });
      if (created.type !== "created") throw new OpenAIAgentsProtocolError(400, created.message, "environment");
      return { environmentId: created.environment.id };
    },
    async environmentView(session, configuration) {
      if (configuration.type === "none") return { type: "none" };
      if (configuration.type === "self_hosted") return unsupported("environment.type");
      return {
        id: environmentId(session), type: "openai_hosted", capability_directories: [], files: [], plugins: [], skills: [],
        network: { access: configuration.network?.access ?? "enabled", allowed_domains: configuration.network?.allowed_domains ?? [] },
        packages: { python: configuration.packages?.python ?? [], system: configuration.packages?.system ?? [], npm: configuration.packages?.npm ?? [] },
      };
    },
  };
}
