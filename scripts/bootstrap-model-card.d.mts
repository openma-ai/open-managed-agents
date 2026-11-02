export interface BootstrapModelCardConfig {
  omaBaseUrl: string;
  omaApiKey?: string;
  workspaceId?: string;
  provider: string;
  providerKey: string;
  providerBaseUrl?: string;
  customHeaders?: Record<string, string>;
  models: string[];
}

export interface BootstrapModelCardReport {
  workspace_id: string;
  provider: string;
  cards: Array<{
    model_id: string;
    status: "created" | "exists";
    id?: string;
    is_default?: boolean;
    probe?: { ok: boolean | null; message?: string; reason?: string } | null;
  }>;
}

export const DEFAULT_MODEL_HANDLES: string[];
export function parseCustomHeaders(raw: string | undefined): Record<string, string> | undefined;
export function parseBootstrapConfig(env?: Record<string, string | undefined>): BootstrapModelCardConfig;
export function bootstrapModelCards(
  config: BootstrapModelCardConfig,
  options?: { fetch?: typeof fetch },
): Promise<BootstrapModelCardReport>;
