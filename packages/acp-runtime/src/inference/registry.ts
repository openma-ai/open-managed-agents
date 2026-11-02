import type { AcpStatefulAgentSpec } from "../native-state.js";
import type { InferenceConfigAdapter } from "./types.js";

export class InferenceConfigAdapterRegistry {
  private readonly adapters: InferenceConfigAdapter[] = [];

  register(adapter: InferenceConfigAdapter): this {
    this.adapters.push(adapter);
    return this;
  }

  findForAgent(agent: AcpStatefulAgentSpec): InferenceConfigAdapter | null {
    return this.adapters.find((candidate) => candidate.matches(agent)) ?? null;
  }

  list(): readonly InferenceConfigAdapter[] {
    return this.adapters;
  }
}
