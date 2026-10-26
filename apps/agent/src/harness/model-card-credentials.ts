import type { PiModelConfig } from "./pi-provider";

export interface ResolvedModelCardCredentials {
  model: string;
  apiKey: string;
  baseURL?: string;
  provider?: string;
  customHeaders?: Record<string, string>;
  piConfig?: PiModelConfig;
}

/** The fields of a resolved workspace model card this projection reads. */
export interface StoredWorkspaceModelCredentials {
  wireModel: string;
  apiKey: string;
  baseURL?: string;
  provider: string;
  customHeaders?: Record<string, string>;
  piConfig?: Record<string, unknown>;
}

/**
 * Project a resolved workspace model card into Pi runtime inputs. A missing
 * card endpoint means "use Pi's provider catalog". There is no environment
 * layer underneath: nothing from the Worker env can leak into the call.
 */
export function bindStoredModelCardCredentials(
  card: StoredWorkspaceModelCredentials,
): ResolvedModelCardCredentials {
  return {
    model: card.wireModel,
    apiKey: card.apiKey,
    baseURL: card.baseURL,
    provider: card.provider,
    customHeaders: card.customHeaders,
    piConfig: card.piConfig as PiModelConfig | undefined,
  };
}

/**
 * The credential fields handed to buildTools / HarnessContext.env. They are
 * the session's own resolved model-card credentials, so callable_agents and
 * sub-agents inherit the parent's workspace credentials and never read a
 * platform key from the Worker environment.
 */
export function delegationCredentials(creds: ResolvedModelCardCredentials): {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL: string | undefined;
} {
  return {
    ANTHROPIC_API_KEY: creds.apiKey,
    ANTHROPIC_BASE_URL: creds.baseURL,
  };
}
