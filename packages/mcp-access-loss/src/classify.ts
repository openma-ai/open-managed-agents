import {
  integrationAccessLossCatalogs,
  type AccessLossCatalog,
} from "./catalog";

export interface AccessLossResource {
  type: string;
  id: string;
}

export interface UpstreamAccessObservation {
  /** Null when the upstream connection failed before a status existed. */
  httpStatus: number | null;
  bodyText: string;
  serverName: string;
  requestBody: string | null;
  refreshed: boolean;
  refreshFailed: boolean;
  /** `error` field from a rejected token endpoint, when the proxy saw one. */
  refreshFailureCode: string | null;
}

export type AccessLossClassification =
  | { class: "retryable" }
  | {
      class: "scope_lost" | "credential_lost";
      provider: string;
      code: string;
      resource: AccessLossResource | null;
    };

const GENERIC_CREDENTIAL_CODES = ["invalid_grant", "invalid_refresh_token"] as const;

/**
 * Classify the final upstream result. 408, 429, 5xx, network failures, and
 * ordinary 401s stay retryable. A refreshable OAuth failure is not scope
 * loss; only an explicit revoked-credential code is `credential_lost`.
 */
export function classifyUpstreamAccess(
  observation: UpstreamAccessObservation,
  catalogs: readonly AccessLossCatalog[] = integrationAccessLossCatalogs,
): AccessLossClassification {
  const status = observation.httpStatus;
  if (status === null || status === 408 || status === 429 || status >= 500) {
    return { class: "retryable" };
  }

  const named = catalogs.filter((catalog) => matchesServer(observation.serverName, catalog));
  const pool = named.length > 0 ? named : catalogs;
  for (const catalog of pool) {
    const hit = matchCatalog(catalog, observation);
    if (hit) return hit;
  }

  const generic = genericCredentialCode(observation);
  if (generic) {
    return {
      class: "credential_lost",
      provider: "generic",
      code: generic,
      resource: null,
    };
  }
  return { class: "retryable" };
}

function matchesServer(serverName: string, catalog: AccessLossCatalog): boolean {
  const normalized = serverName.trim().toLowerCase();
  return catalog.serverNames.some((name) =>
    normalized === name
    || normalized.startsWith(`${name}-`)
    || normalized.endsWith(`-${name}`)
  );
}

function matchCatalog(
  catalog: AccessLossCatalog,
  observation: UpstreamAccessObservation,
): AccessLossClassification | null {
  const haystack = `${observation.bodyText}\n${observation.refreshFailureCode ?? ""}`;
  for (const entry of catalog.scopeLost) {
    if (hasToken(haystack, entry.code)) {
      return {
        class: "scope_lost",
        provider: catalog.provider,
        code: entry.code,
        resource: resourceFrom(observation.requestBody, entry.resourceType),
      };
    }
  }
  const lowered = haystack.toLowerCase();
  for (const phrase of catalog.phrases) {
    if (lowered.includes(phrase.phrase)) {
      return {
        class: "scope_lost",
        provider: catalog.provider,
        code: phrase.code,
        resource: resourceFrom(observation.requestBody, phrase.resourceType),
      };
    }
  }
  for (const code of catalog.credentialLost) {
    if (hasToken(haystack, code)) {
      return {
        class: "credential_lost",
        provider: catalog.provider,
        code,
        resource: null,
      };
    }
  }
  return null;
}

function genericCredentialCode(observation: UpstreamAccessObservation): string | null {
  if (!observation.refreshFailed) return null;
  const haystack = `${observation.bodyText}\n${observation.refreshFailureCode ?? ""}`;
  for (const code of GENERIC_CREDENTIAL_CODES) {
    if (hasToken(haystack, code)) return code;
  }
  return null;
}

function hasToken(haystack: string, code: string): boolean {
  const pattern = new RegExp(`(?:^|[^a-z0-9_])${code}(?:$|[^a-z0-9_])`, "i");
  return pattern.test(haystack);
}

function resourceFrom(requestBody: string | null, resourceType: string): AccessLossResource | null {
  if (!requestBody) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    return null;
  }
  const argumentsObject = findArguments(parsed);
  if (!argumentsObject) return null;
  const keys = resourceKeys(resourceType);
  for (const key of keys) {
    const value = argumentsObject[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 256) {
      return { type: resourceType, id: value };
    }
  }
  if (resourceType === "repository") {
    const owner = argumentsObject.owner;
    const repo = argumentsObject.repo;
    if (typeof owner === "string" && typeof repo === "string" && owner && repo) {
      return { type: "repository", id: `${owner}/${repo}` };
    }
  }
  return null;
}

function findArguments(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.arguments && typeof record.arguments === "object") {
    return record.arguments as Record<string, unknown>;
  }
  const params = record.params;
  if (params && typeof params === "object") {
    const nested = (params as Record<string, unknown>).arguments;
    if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  }
  return null;
}

function resourceKeys(resourceType: string): string[] {
  switch (resourceType) {
    case "channel":
      return ["channel_id", "channel"];
    case "issue":
      return ["issue_id", "issueId", "id"];
    case "repository":
      return ["repository", "repo"];
    case "installation":
      return ["installation_id", "installationId"];
    default:
      return [];
  }
}
