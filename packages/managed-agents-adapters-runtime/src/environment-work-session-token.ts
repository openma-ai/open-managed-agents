import type {
  EnvironmentWorkSessionCredentialIssuerPort,
  IssueEnvironmentWorkSessionCredential,
  IssueEnvironmentWorkSessionCredentialResult,
} from "@open-managed-agents/managed-agents-application";

const TOKEN_PREFIX = "sk-ant-req-v1.";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface EnvironmentWorkSessionTokenCrypto {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export interface SealedEnvironmentWorkSessionCredentialIssuerDependencies {
  crypto: EnvironmentWorkSessionTokenCrypto;
  now(): Date;
  ttlMs?: number;
  apiBaseUrl?: string;
}

interface EnvironmentWorkSessionTokenClaims {
  version: 1;
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  issuedAt: string;
  expiresAt: string;
  skills: Array<{ skillId: string; version: string }>;
  memoryStores: Array<{
    memoryStoreId: string;
    access: "read_only" | "read_write";
  }>;
}

export class SealedEnvironmentWorkSessionCredentialIssuer
  implements EnvironmentWorkSessionCredentialIssuerPort
{
  readonly #ttlMs: number;

  constructor(
    private readonly dependencies: SealedEnvironmentWorkSessionCredentialIssuerDependencies,
  ) {
    this.#ttlMs = dependencies.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new Error("Environment Work Session credential ttlMs must be a positive integer");
    }
  }

  async issue(
    input: IssueEnvironmentWorkSessionCredential,
  ): Promise<IssueEnvironmentWorkSessionCredentialResult> {
    const issuedAt = this.dependencies.now();
    const claims: EnvironmentWorkSessionTokenClaims = {
      version: 1,
      workspaceId: input.workspaceId,
      environmentId: input.environment.id,
      sessionId: input.session.id,
      workId: input.workId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.#ttlMs).toISOString(),
      skills: input.session.agent.skills.map((skill) => ({
        skillId: skill.skillId,
        version: skill.version,
      })),
      memoryStores: input.session.resources
        .filter((resource) => resource.type === "memory_store")
        .map((resource) => ({
          memoryStoreId: resource.memoryStoreId,
          access: resource.access === "read_only" ? "read_only" : "read_write",
        })),
    };
    const ciphertext = await this.dependencies.crypto.encrypt(JSON.stringify(claims));
    if (ciphertext.length === 0) {
      return { type: "rejected", message: "Session credential ciphertext is empty" };
    }
    return {
      type: "issued",
      secret: {
        sessionsToken: `${TOKEN_PREFIX}${ciphertext}`,
        ...(this.dependencies.apiBaseUrl !== undefined && {
          apiBaseUrl: this.dependencies.apiBaseUrl,
        }),
      },
    };
  }
}

export interface AuthenticateEnvironmentWorkSessionBearerInput {
  token: string;
  method: string;
  path: string;
  crypto: EnvironmentWorkSessionTokenCrypto;
  now(): Date;
}

export interface EnvironmentWorkSessionBearerResolution {
  workspaceId: string;
  sessionId: string;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClaims(value: unknown): EnvironmentWorkSessionTokenClaims | null {
  if (!isStringRecord(value) || value.version !== 1) return null;
  for (const field of [
    "workspaceId",
    "environmentId",
    "sessionId",
    "workId",
    "issuedAt",
    "expiresAt",
  ] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) return null;
  }
  if (!Array.isArray(value.skills) || !Array.isArray(value.memoryStores)) return null;
  const skills: EnvironmentWorkSessionTokenClaims["skills"] = [];
  for (const skill of value.skills) {
    if (
      !isStringRecord(skill)
      || typeof skill.skillId !== "string"
      || typeof skill.version !== "string"
    ) return null;
    skills.push({ skillId: skill.skillId, version: skill.version });
  }
  const memoryStores: EnvironmentWorkSessionTokenClaims["memoryStores"] = [];
  for (const store of value.memoryStores) {
    if (
      !isStringRecord(store)
      || typeof store.memoryStoreId !== "string"
      || (store.access !== "read_only" && store.access !== "read_write")
    ) return null;
    memoryStores.push({ memoryStoreId: store.memoryStoreId, access: store.access });
  }
  return {
    version: 1,
    workspaceId: value.workspaceId as string,
    environmentId: value.environmentId as string,
    sessionId: value.sessionId as string,
    workId: value.workId as string,
    issuedAt: value.issuedAt as string,
    expiresAt: value.expiresAt as string,
    skills,
    memoryStores,
  };
}

function authorized(claims: EnvironmentWorkSessionTokenClaims, method: string, path: string): boolean {
  const parts = path.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  const verb = method.toUpperCase();
  if (
    parts.length === 6
    && parts[0] === "v1"
    && parts[1] === "environments"
    && parts[2] === claims.environmentId
    && parts[3] === "work"
    && parts[4] === claims.workId
    && (parts[5] === "heartbeat" || parts[5] === "stop")
  ) return verb === "POST";

  if (
    parts[0] === "v1"
    && parts[1] === "sessions"
    && parts[2] === claims.sessionId
  ) {
    if (parts.length === 3) return verb === "GET";
    if (parts.length === 4 && parts[3] === "events") {
      return verb === "GET" || verb === "POST";
    }
    if (parts.length === 5 && parts[3] === "events" && parts[4] === "stream") {
      return verb === "GET";
    }
    return false;
  }

  if (parts[0] === "v1" && parts[1] === "skills" && verb === "GET") {
    const skill = claims.skills.find((candidate) => candidate.skillId === parts[2]);
    if (skill === undefined) return false;
    if (parts.length === 3) return true;
    if (parts.length === 4 && parts[3] === "versions") return true;
    if (
      (parts.length === 5 || (parts.length === 6 && parts[5] === "content"))
      && parts[3] === "versions"
      && parts[4] === skill.version
    ) return true;
    return false;
  }

  if (parts[0] === "v1" && parts[1] === "memory_stores") {
    const store = claims.memoryStores.find(
      (candidate) => candidate.memoryStoreId === parts[2],
    );
    if (store === undefined) return false;
    if (parts.length === 3) return verb === "GET";
    const isRead = verb === "GET";
    const isWrite = store.access === "read_write" && (verb === "POST" || verb === "DELETE");
    if (parts[3] === "memories" && (parts.length === 4 || parts.length === 5)) {
      return isRead || isWrite;
    }
    if (parts[3] === "memory_versions" && (parts.length === 4 || parts.length === 5)) {
      return isRead;
    }
  }
  return false;
}

export async function authenticateEnvironmentWorkSessionBearer(
  input: AuthenticateEnvironmentWorkSessionBearerInput,
): Promise<EnvironmentWorkSessionBearerResolution | null> {
  if (!input.token.startsWith(TOKEN_PREFIX)) return null;
  try {
    const plaintext = await input.crypto.decrypt(input.token.slice(TOKEN_PREFIX.length));
    const claims = parseClaims(JSON.parse(plaintext));
    if (claims === null) return null;
    const issuedAt = Date.parse(claims.issuedAt);
    const expiresAt = Date.parse(claims.expiresAt);
    const now = input.now().getTime();
    if (
      !Number.isFinite(issuedAt)
      || !Number.isFinite(expiresAt)
      || expiresAt <= issuedAt
      || now < issuedAt
      || now >= expiresAt
    ) return null;
    if (!authorized(claims, input.method, input.path)) return null;
    return { workspaceId: claims.workspaceId, sessionId: claims.sessionId };
  } catch {
    return null;
  }
}
