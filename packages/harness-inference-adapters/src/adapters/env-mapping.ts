import type {
  InferenceConfigAdapter,
  InferenceConfigPlan,
  InferenceConfigPlanContext,
} from "@open-managed-agents/acp-runtime/inference-config";
import type { AcpStatefulAgentSpec } from "@open-managed-agents/acp-runtime/native-state";

export interface EnvMappingInferenceRule {
  readonly matchEnv?: Readonly<Record<string, string>>;
  readonly supportedProtocols: InferenceConfigAdapter["supportedProtocols"];
  readonly plan: (context: InferenceConfigPlanContext) => InferenceConfigPlan;
}

/**
 * Declarative adapter for registry agents that map hosted inference through env
 * templates instead of bespoke harness modules.
 */
export function createEnvMappingInferenceAdapter(input: {
  id: string;
  rules: readonly EnvMappingInferenceRule[];
}): InferenceConfigAdapter {
  return {
    id: input.id,
    supportedProtocols: uniqueProtocols(input.rules),
    matches(agent: AcpStatefulAgentSpec) {
      return input.rules.some((rule) => matchesEnv(agent, rule.matchEnv));
    },
    plan(context) {
      const rule = input.rules.find((candidate) =>
        matchesEnv(context.agent, candidate.matchEnv)
      );
      if (!rule) {
        throw new Error(`No env mapping rule for adapter ${input.id}`);
      }
      return rule.plan(context);
    },
  };
}

function uniqueProtocols(
  rules: readonly EnvMappingInferenceRule[],
): InferenceConfigAdapter["supportedProtocols"] {
  const protocols = new Set<InferenceConfigAdapter["supportedProtocols"][number]>();
  for (const rule of rules) {
    for (const protocol of rule.supportedProtocols) {
      protocols.add(protocol);
    }
  }
  return [...protocols];
}

function matchesEnv(
  agent: AcpStatefulAgentSpec,
  matchEnv?: Readonly<Record<string, string>>,
): boolean {
  if (!matchEnv) return false;
  const env = agent.env ?? {};
  return Object.entries(matchEnv).every(([key, value]) => env[key] === value);
}
