/**
 * Durable state of the Matter service. With MySQL (`MATTER_DATABASE_URL`)
 * every replica shares it, so any replica can serve any request: the
 * connections users made (secrets sealed), the hashes of per-Session MCP
 * bearers, "Connect Feishu" registrations in progress, the tools of each
 * Session's latest Turn, and the operation calls an Agent made through MCP.
 * Each connection's OpenMatter store and inbox live in the same database,
 * partitioned by connection key. Without MySQL the same tables live in one
 * SQLite file for a single local process.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FeishuBrand } from "@openma/matter-feishu/bond";
import type { DurableInbox } from "@openma/matter/inbox";
import type { OpenMatterStore } from "@openma/matter/store";
import { makeMysqlInbox } from "@openma/matter-inbox-mysql";
import { makeSqliteInbox } from "@openma/matter-inbox-sqlite";
import { makeMysqlStore } from "@openma/matter-store-mysql";
import { makeSqliteStore } from "@openma/matter-store-sqlite";
import type { Effect } from "effect";
import { createPool, type Pool, type ResultSetHeader } from "mysql2/promise";
import type {
  FeishuConnection,
  FeishuConnectStatus,
  RegistrationRecord,
  RegistrationStore,
} from "./feishu-connect.js";
import type { SessionTokenStore } from "./session-tokens.js";
import type { CallStore } from "./tool-bridge.js";

/** AES-256-GCM with a key derived from the operator's secret. The purpose is
 * bound as additional data, so a sealed value cannot be moved to another
 * column or row. */
export interface SecretBox {
  seal(plaintext: string, purpose: string): string;
  open(sealed: string, purpose: string): string;
}

export const createSecretBox = (secret: string): SecretBox => {
  if (secret.length < 16) {
    throw new Error("MATTER_SECRET_KEY must be at least 16 characters");
  }
  const key = createHash("sha256").update(`openmatter:${secret}`, "utf8").digest();
  return {
    seal: (plaintext, purpose) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(purpose, "utf8"));
      const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return ["v1", iv, cipher.getAuthTag(), data]
        .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
        .join(".");
    },
    open: (sealed, purpose) => {
      const [version, iv, tag, data] = sealed.split(".");
      if (version !== "v1" || iv === undefined || tag === undefined || data === undefined) {
        throw new Error("Unrecognized sealed value");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(purpose, "utf8"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString(
        "utf8",
      );
    },
  };
};

/** A connected Feishu app with its secret opened. */
export interface FeishuAppRecord {
  readonly appId: string;
  readonly appSecret: string;
  readonly brand: FeishuBrand;
  readonly baseUrl: string;
  readonly tenantId: string;
  readonly userId?: string;
  /** The Agent saved before Loops existed; empty once migrated. */
  readonly agentId: string;
  readonly botOpenId?: string;
  readonly connectedAt: string;
}

/** A connected GitLab instance with its secrets opened. */
export interface GitLabConnectionRecord {
  /** `gitlab-<hex>`: the connection key and the webhook path segment. */
  readonly id: string;
  /** The instance root, for example `https://gitlab.example.com`. */
  readonly baseUrl: string;
  /** The bot user's token; notes are posted as this user. `read_repository`
   * is enough to clone, `api` is needed to post notes. */
  readonly token: string;
  /** The bot user's username, without @; comments mentioning it are answered. */
  readonly username: string;
  /** GitLab checks it on every webhook (`X-Gitlab-Token`). */
  readonly webhookSecret: string;
  /** Numeric ids of the projects whose comments are answered. */
  readonly projectIds: readonly number[];
  readonly tenantId: string;
  readonly userId?: string;
  readonly agentId: string;
  /** The token's scopes and expiry (YYYY-MM-DD), when GitLab told them at
   * link time; shown to the user only. */
  readonly tokenScopes?: readonly string[];
  readonly tokenExpiresAt?: string;
  readonly connectedAt: string;
}

export type GitLabConnectionInput = Omit<GitLabConnectionRecord, "connectedAt">;

/**
 * One Loop instance: a template (`feishu-agent`, `gitlab-mention`, …) with
 * its configuration, running on one Bond (a connected Feishu app or GitLab
 * instance). The answering Agent is part of the configuration.
 */
export interface LoopRecord {
  readonly id: string;
  readonly tenantId: string;
  /** The Bond's adapter kind and connection key. */
  readonly bondKind: string;
  readonly bondKey: string;
  readonly template: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type LoopInput = Omit<LoopRecord, "createdAt" | "updatedAt">;

export interface ConnectionError {
  readonly message: string;
  readonly at: string;
}

export interface MatterDatabase {
  readonly apps: {
    /** Insert, or replace the same tenant's app (connecting it again). An
     * app another tenant linked stays theirs: the record returned is
     * theirs, unchanged. */
    save(connection: FeishuConnection, extra?: { readonly botOpenId?: string }): Promise<FeishuAppRecord>;
    list(): Promise<readonly FeishuAppRecord[]>;
    get(appId: string): Promise<FeishuAppRecord | undefined>;
    delete(appId: string): Promise<boolean>;
    /** Clear the Agent saved before Loops existed, once it became a Loop. */
    forgetAgent(appId: string): Promise<void>;
  };
  readonly gitlab: {
    /** Insert or replace by id. */
    save(connection: GitLabConnectionInput): Promise<GitLabConnectionRecord>;
    list(): Promise<readonly GitLabConnectionRecord[]>;
    get(id: string): Promise<GitLabConnectionRecord | undefined>;
    delete(id: string): Promise<boolean>;
    forgetAgent(id: string): Promise<void>;
  };
  readonly loops: {
    list(): Promise<readonly LoopRecord[]>;
    listForBond(bondKind: string, bondKey: string): Promise<readonly LoopRecord[]>;
    get(id: string): Promise<LoopRecord | undefined>;
    /** Insert or replace by id; keeps the creation time. */
    save(loop: LoopInput): Promise<LoopRecord>;
    /** Insert unless the id exists (for idempotent migrations). */
    saveIfAbsent(loop: LoopInput): Promise<void>;
    delete(id: string): Promise<boolean>;
    deleteForBond(bondKind: string, bondKey: string): Promise<void>;
  };
  readonly tokens: SessionTokenStore;
  readonly registrations: RegistrationStore;
  /** The last error of each connection, shared by every replica: the
   * replica that hit it (a failed start or a failed delivery) writes it, and
   * any replica can show it. */
  readonly errors: {
    get(key: string): Promise<ConnectionError | undefined>;
    set(key: string, error: ConnectionError): Promise<void>;
    clear(key: string): Promise<void>;
  };
  /** Operation calls an Agent made through MCP, shared by every replica:
   * the replica running the Turn announces and answers them; the replica
   * that received the MCP request claims one and waits for its answer. */
  readonly calls: CallStore & {
    /** Drop calls and Session tool lists older than `beforeMs`. */
    prune(beforeMs: number): Promise<void>;
  };
  /** One connection's OpenMatter store and inbox. */
  connectionStorage(key: string): {
    readonly store: OpenMatterStore & { readonly close: Effect.Effect<void, unknown> };
    readonly inbox: DurableInbox & { readonly close: Effect.Effect<void, unknown> };
  };
  readonly kind: "sqlite" | "mysql";
  close(): Promise<void>;
}

/** The two SQL engines, behind the few operations this file needs. */
interface SqlDriver {
  readonly kind: "sqlite" | "mysql";
  rows<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Number of changed rows. */
  run(sql: string, params?: readonly unknown[]): Promise<number>;
}

const sqliteDriver = (db: DatabaseSync): SqlDriver => ({
  kind: "sqlite",
  rows: async <T>(sql: string, params: readonly unknown[] = []) =>
    db.prepare(sql).all(...(params as never[])) as T[],
  run: async (sql, params = []) => Number(db.prepare(sql).run(...(params as never[])).changes),
});

const mysqlDriver = (pool: Pool): SqlDriver => ({
  kind: "mysql",
  rows: async <T>(sql: string, params: readonly unknown[] = []) => {
    const [rows] = await pool.query(sql, params as unknown[]);
    return rows as T[];
  },
  run: async (sql, params = []) => {
    const [result] = await pool.query(sql, params as unknown[]);
    return (result as ResultSetHeader).affectedRows;
  },
});

/** Tables, written once for both engines: keys are VARCHAR(191) (MySQL
 * cannot index TEXT), text columns LONGTEXT/TEXT. */
const tables = (kind: "sqlite" | "mysql"): string[] => {
  const key = kind === "mysql" ? "VARCHAR(191)" : "TEXT";
  const text = kind === "mysql" ? "LONGTEXT" : "TEXT";
  const int = kind === "mysql" ? "BIGINT" : "INTEGER";
  return [
    `CREATE TABLE IF NOT EXISTS openmatter_feishu_apps (
      app_id ${key} PRIMARY KEY, app_secret ${text} NOT NULL, brand ${key} NOT NULL,
      base_url ${text} NOT NULL, tenant_id ${key} NOT NULL, user_id ${key}, agent_id ${key} NOT NULL,
      bot_open_id ${key}, connected_at ${key} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS openmatter_gitlab_connections (
      id ${key} PRIMARY KEY, base_url ${text} NOT NULL, token ${text} NOT NULL, username ${key} NOT NULL,
      webhook_secret ${text} NOT NULL, project_ids ${text} NOT NULL, tenant_id ${key} NOT NULL,
      user_id ${key}, agent_id ${key} NOT NULL, connected_at ${key} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS openmatter_loops (
      id ${key} PRIMARY KEY, tenant_id ${key} NOT NULL, bond_kind ${key} NOT NULL, bond_key ${key} NOT NULL,
      template ${key} NOT NULL, config_json ${text} NOT NULL, enabled ${int} NOT NULL,
      created_at ${key} NOT NULL, updated_at ${key} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS openmatter_connection_errors (
      connection_key ${key} PRIMARY KEY, message ${text} NOT NULL, failed_at ${key} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS openmatter_session_tokens (
      digest ${key} PRIMARY KEY, session_id ${key} NOT NULL, issued_at ${key} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS openmatter_registrations (
      id ${key} PRIMARY KEY, tenant_id ${key} NOT NULL, user_id ${key}, agent_id ${key},
      device_code ${text} NOT NULL, brand ${key} NOT NULL, interval_s ${int} NOT NULL,
      expires_at_ms ${int} NOT NULL, status_json ${text} NOT NULL, next_poll_at_ms ${int} NOT NULL,
      lease_owner ${key}, lease_until_ms ${int}, finished_at_ms ${int})`,
    `CREATE TABLE IF NOT EXISTS openmatter_session_tools (
      session_id ${key} PRIMARY KEY, tools_json ${text} NOT NULL, updated_at_ms ${int} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS openmatter_tool_calls (
      callback_id ${key} PRIMARY KEY, session_id ${key} NOT NULL, call_key ${key} NOT NULL,
      seq ${int} NOT NULL, claimed_by ${key}, outcome_json ${text}, created_at_ms ${int} NOT NULL)`,
    kind === "mysql"
      ? `CREATE INDEX openmatter_tool_calls_match ON openmatter_tool_calls (session_id, call_key)`
      : `CREATE INDEX IF NOT EXISTS openmatter_tool_calls_match ON openmatter_tool_calls (session_id, call_key)`,
  ];
};

/** Nullable text columns added after a table was first created, as
 * `[table, column]`; added when missing. */
const addedColumns: readonly (readonly [string, string])[] = [
  ["openmatter_gitlab_connections", "token_scopes"],
  ["openmatter_gitlab_connections", "token_expires_at"],
];

/** `INSERT … ON CONFLICT DO UPDATE` in each dialect. With `guard`, an
 * existing row is replaced only when its `guard` column already has the
 * new value (the same owner). */
const upsert = (
  kind: "sqlite" | "mysql",
  table: string,
  columns: readonly string[],
  key: string,
  guard?: string,
): string => {
  const updates = columns.filter((c) => c !== key);
  const placeholders = columns.map(() => "?").join(", ");
  const head = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
  if (kind === "mysql") {
    const value = (c: string) => (guard === undefined ? `VALUES(${c})` : `IF(${guard} = VALUES(${guard}), VALUES(${c}), ${c})`);
    return `${head} ON DUPLICATE KEY UPDATE ${updates.map((c) => `${c} = ${value(c)}`).join(", ")}`;
  }
  const where = guard === undefined ? "" : ` WHERE ${table}.${guard} = excluded.${guard}`;
  return `${head} ON CONFLICT (${key}) DO UPDATE SET ${updates.map((c) => `${c} = excluded.${c}`).join(", ")}${where}`;
};

const insertIgnore = (kind: "sqlite" | "mysql") =>
  kind === "mysql" ? "INSERT IGNORE INTO" : "INSERT OR IGNORE INTO";

const appSecretPurpose = (appId: string) => `feishu-app-secret:${appId}`;
const gitlabTokenPurpose = (id: string) => `gitlab-token:${id}`;
const gitlabWebhookPurpose = (id: string) => `gitlab-webhook-secret:${id}`;
const deviceCodePurpose = (id: string) => `feishu-device-code:${id}`;

const tokenDigest = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

/** A long call key (tool name and canonical arguments) as an indexable digest. */
export const callKeyDigest = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex");

/** Announcement order across replicas: microseconds, strictly increasing
 * within a process (a Turn's calls are announced by one process). */
let lastSeq = 0;
const nextSeq = (nowMs: number): number => {
  lastSeq = Math.max(nowMs * 1000, lastSeq + 1);
  return lastSeq;
};

type Num = number | bigint | string | null;
const n = (value: Num): number | undefined => (value === null ? undefined : Number(value));

const createMatterDatabase = (
  sql: SqlDriver,
  box: SecretBox,
  storage: MatterDatabase["connectionStorage"],
  close: () => Promise<void>,
  now: () => Date,
): MatterDatabase => {
  type AppRow = {
    app_id: string;
    app_secret: string;
    brand: string;
    base_url: string;
    tenant_id: string;
    user_id: string | null;
    agent_id: string;
    bot_open_id: string | null;
    connected_at: string;
  };
  const toApp = (row: AppRow): FeishuAppRecord => ({
    appId: row.app_id,
    appSecret: box.open(row.app_secret, appSecretPurpose(row.app_id)),
    brand: row.brand as FeishuBrand,
    baseUrl: row.base_url,
    tenantId: row.tenant_id,
    ...(row.user_id === null ? {} : { userId: row.user_id }),
    agentId: row.agent_id,
    ...(row.bot_open_id === null ? {} : { botOpenId: row.bot_open_id }),
    connectedAt: row.connected_at,
  });
  type GitLabRow = {
    id: string;
    base_url: string;
    token: string;
    username: string;
    webhook_secret: string;
    project_ids: string;
    tenant_id: string;
    user_id: string | null;
    agent_id: string;
    token_scopes: string | null;
    token_expires_at: string | null;
    connected_at: string;
  };
  const toGitLab = (row: GitLabRow): GitLabConnectionRecord => ({
    id: row.id,
    baseUrl: row.base_url,
    token: box.open(row.token, gitlabTokenPurpose(row.id)),
    username: row.username,
    webhookSecret: box.open(row.webhook_secret, gitlabWebhookPurpose(row.id)),
    projectIds: JSON.parse(row.project_ids) as number[],
    tenantId: row.tenant_id,
    ...(row.user_id === null ? {} : { userId: row.user_id }),
    agentId: row.agent_id,
    ...(row.token_scopes === null ? {} : { tokenScopes: JSON.parse(row.token_scopes) as string[] }),
    ...(row.token_expires_at === null ? {} : { tokenExpiresAt: row.token_expires_at }),
    connectedAt: row.connected_at,
  });
  type RegistrationRow = {
    id: string;
    tenant_id: string;
    user_id: string | null;
    agent_id: string | null;
    device_code: string;
    brand: string;
    interval_s: Num;
    expires_at_ms: Num;
    status_json: string;
    next_poll_at_ms: Num;
    finished_at_ms: Num;
  };
  const toRegistration = (row: RegistrationRow): RegistrationRecord => ({
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.user_id === null ? {} : { userId: row.user_id }),
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    deviceCode: box.open(row.device_code, deviceCodePurpose(row.id)),
    brand: row.brand as FeishuBrand,
    intervalS: n(row.interval_s)!,
    expiresAtMs: n(row.expires_at_ms)!,
    status: JSON.parse(row.status_json) as FeishuConnectStatus,
    nextPollAtMs: n(row.next_poll_at_ms)!,
    ...(row.finished_at_ms === null ? {} : { finishedAtMs: n(row.finished_at_ms)! }),
  });

  const appColumns = [
    "app_id",
    "app_secret",
    "brand",
    "base_url",
    "tenant_id",
    "user_id",
    "agent_id",
    "bot_open_id",
    "connected_at",
  ];
  const gitlabColumns = [
    "id",
    "base_url",
    "token",
    "username",
    "webhook_secret",
    "project_ids",
    "tenant_id",
    "user_id",
    "agent_id",
    "token_scopes",
    "token_expires_at",
    "connected_at",
  ];
  const getApp = async (appId: string) => {
    const [row] = await sql.rows<AppRow>(`SELECT * FROM openmatter_feishu_apps WHERE app_id = ?`, [appId]);
    return row === undefined ? undefined : toApp(row);
  };
  const getGitLab = async (id: string) => {
    const [row] = await sql.rows<GitLabRow>(`SELECT * FROM openmatter_gitlab_connections WHERE id = ?`, [id]);
    return row === undefined ? undefined : toGitLab(row);
  };
  type LoopRow = {
    id: string;
    tenant_id: string;
    bond_kind: string;
    bond_key: string;
    template: string;
    config_json: string;
    enabled: Num;
    created_at: string;
    updated_at: string;
  };
  const toLoop = (row: LoopRow): LoopRecord => ({
    id: row.id,
    tenantId: row.tenant_id,
    bondKind: row.bond_kind,
    bondKey: row.bond_key,
    template: row.template,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    enabled: Number(row.enabled) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const loopColumns = [
    "id",
    "tenant_id",
    "bond_kind",
    "bond_key",
    "template",
    "config_json",
    "enabled",
    "created_at",
    "updated_at",
  ];
  const getLoop = async (id: string) => {
    const [row] = await sql.rows<LoopRow>(`SELECT * FROM openmatter_loops WHERE id = ?`, [id]);
    return row === undefined ? undefined : toLoop(row);
  };
  const loopValues = (loop: LoopInput, createdAt: string, updatedAt: string) => [
    loop.id,
    loop.tenantId,
    loop.bondKind,
    loop.bondKey,
    loop.template,
    JSON.stringify(loop.config),
    loop.enabled ? 1 : 0,
    createdAt,
    updatedAt,
  ];
  const getRegistration = async (id: string) => {
    const [row] = await sql.rows<RegistrationRow>(`SELECT * FROM openmatter_registrations WHERE id = ?`, [id]);
    return row === undefined ? undefined : toRegistration(row);
  };

  return {
    kind: sql.kind,
    apps: {
      save: async (connection, extra = {}) => {
        const { app } = connection;
        await sql.run(upsert(sql.kind, "openmatter_feishu_apps", appColumns, "app_id", "tenant_id"), [
          app.appId,
          box.seal(app.appSecret, appSecretPurpose(app.appId)),
          app.brand,
          app.baseUrl,
          connection.tenantId,
          connection.userId ?? null,
          connection.agentId ?? "",
          extra.botOpenId ?? null,
          now().toISOString(),
        ]);
        return (await getApp(app.appId))!;
      },
      list: async () =>
        (await sql.rows<AppRow>(`SELECT * FROM openmatter_feishu_apps ORDER BY connected_at, app_id`)).map(toApp),
      get: getApp,
      delete: async (appId) => (await sql.run(`DELETE FROM openmatter_feishu_apps WHERE app_id = ?`, [appId])) > 0,
      forgetAgent: async (appId) => {
        await sql.run(`UPDATE openmatter_feishu_apps SET agent_id = '' WHERE app_id = ?`, [appId]);
      },
    },
    gitlab: {
      save: async (c) => {
        await sql.run(upsert(sql.kind, "openmatter_gitlab_connections", gitlabColumns, "id"), [
          c.id,
          c.baseUrl,
          box.seal(c.token, gitlabTokenPurpose(c.id)),
          c.username,
          box.seal(c.webhookSecret, gitlabWebhookPurpose(c.id)),
          JSON.stringify(c.projectIds),
          c.tenantId,
          c.userId ?? null,
          c.agentId,
          c.tokenScopes === undefined ? null : JSON.stringify(c.tokenScopes),
          c.tokenExpiresAt ?? null,
          now().toISOString(),
        ]);
        return (await getGitLab(c.id))!;
      },
      list: async () =>
        (await sql.rows<GitLabRow>(`SELECT * FROM openmatter_gitlab_connections ORDER BY connected_at, id`)).map(
          toGitLab,
        ),
      get: getGitLab,
      delete: async (id) => (await sql.run(`DELETE FROM openmatter_gitlab_connections WHERE id = ?`, [id])) > 0,
      forgetAgent: async (id) => {
        await sql.run(`UPDATE openmatter_gitlab_connections SET agent_id = '' WHERE id = ?`, [id]);
      },
    },
    loops: {
      list: async () =>
        (await sql.rows<LoopRow>(`SELECT * FROM openmatter_loops ORDER BY created_at, id`)).map(toLoop),
      listForBond: async (bondKind, bondKey) =>
        (
          await sql.rows<LoopRow>(
            `SELECT * FROM openmatter_loops WHERE bond_kind = ? AND bond_key = ? ORDER BY created_at, id`,
            [bondKind, bondKey],
          )
        ).map(toLoop),
      get: getLoop,
      save: async (loop) => {
        const stamp = now().toISOString();
        const createdAt = (await getLoop(loop.id))?.createdAt ?? stamp;
        await sql.run(upsert(sql.kind, "openmatter_loops", loopColumns, "id"), loopValues(loop, createdAt, stamp));
        return (await getLoop(loop.id))!;
      },
      saveIfAbsent: async (loop) => {
        const stamp = now().toISOString();
        await sql.run(
          `${insertIgnore(sql.kind)} openmatter_loops (${loopColumns.join(", ")}) VALUES (${loopColumns.map(() => "?").join(", ")})`,
          loopValues(loop, stamp, stamp),
        );
      },
      delete: async (id) => (await sql.run(`DELETE FROM openmatter_loops WHERE id = ?`, [id])) > 0,
      deleteForBond: async (bondKind, bondKey) => {
        await sql.run(`DELETE FROM openmatter_loops WHERE bond_kind = ? AND bond_key = ?`, [bondKind, bondKey]);
      },
    },
    tokens: {
      issue: async (sessionId) => {
        const token = `omt_${randomBytes(32).toString("base64url")}`;
        await sql.run(`INSERT INTO openmatter_session_tokens (digest, session_id, issued_at) VALUES (?, ?, ?)`, [
          tokenDigest(token).toString("hex"),
          sessionId,
          now().toISOString(),
        ]);
        return token;
      },
      resolve: async (token) => {
        if (token.length === 0) return null;
        const digest = tokenDigest(token);
        const [row] = await sql.rows<{ digest: string; session_id: string }>(
          `SELECT digest, session_id FROM openmatter_session_tokens WHERE digest = ?`,
          [digest.toString("hex")],
        );
        return row !== undefined && timingSafeEqual(Buffer.from(row.digest, "hex"), digest) ? row.session_id : null;
      },
    },
    errors: {
      get: async (key) => {
        const [row] = await sql.rows<{ message: string; failed_at: string }>(
          `SELECT message, failed_at FROM openmatter_connection_errors WHERE connection_key = ?`,
          [key],
        );
        return row === undefined ? undefined : { message: row.message, at: row.failed_at };
      },
      set: async (key, error) => {
        await sql.run(
          upsert(sql.kind, "openmatter_connection_errors", ["connection_key", "message", "failed_at"], "connection_key"),
          [key, error.message, error.at],
        );
      },
      clear: async (key) => {
        await sql.run(`DELETE FROM openmatter_connection_errors WHERE connection_key = ?`, [key]);
      },
    },
    registrations: {
      create: async (r) => {
        await sql.run(
          `INSERT INTO openmatter_registrations (id, tenant_id, user_id, agent_id, device_code, brand,
             interval_s, expires_at_ms, status_json, next_poll_at_ms, finished_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            r.id,
            r.tenantId,
            r.userId ?? null,
            r.agentId ?? null,
            box.seal(r.deviceCode, deviceCodePurpose(r.id)),
            r.brand,
            r.intervalS,
            r.expiresAtMs,
            JSON.stringify(r.status),
            r.nextPollAtMs,
            r.finishedAtMs ?? null,
          ],
        );
      },
      get: getRegistration,
      claim: async (id, ownerId, nowMs, leaseUntilMs) => {
        const due = await sql.rows<{ id: string }>(
          `SELECT id FROM openmatter_registrations
           WHERE finished_at_ms IS NULL AND next_poll_at_ms <= ?
             AND (lease_until_ms IS NULL OR lease_until_ms <= ?)${id === undefined ? "" : " AND id = ?"}
           ORDER BY next_poll_at_ms LIMIT 5`,
          id === undefined ? [nowMs, nowMs] : [nowMs, nowMs, id],
        );
        for (const { id: candidate } of due) {
          const taken = await sql.run(
            `UPDATE openmatter_registrations SET lease_owner = ?, lease_until_ms = ?
             WHERE id = ? AND finished_at_ms IS NULL AND next_poll_at_ms <= ?
               AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`,
            [ownerId, leaseUntilMs, candidate, nowMs, nowMs],
          );
          if (taken === 1) return getRegistration(candidate);
        }
        return undefined;
      },
      update: async (id, ownerId, patch) => {
        await sql.run(
          `UPDATE openmatter_registrations
           SET status_json = ?, interval_s = COALESCE(?, interval_s), brand = COALESCE(?, brand),
               next_poll_at_ms = ?, finished_at_ms = ?, lease_owner = NULL, lease_until_ms = NULL
           WHERE id = ? AND lease_owner = ?`,
          [
            JSON.stringify(patch.status),
            patch.intervalS ?? null,
            patch.brand ?? null,
            patch.nextPollAtMs,
            patch.finishedAtMs ?? null,
            id,
            ownerId,
          ],
        );
      },
      patchStatus: async (id, status) => {
        await sql.run(`UPDATE openmatter_registrations SET status_json = ? WHERE id = ?`, [
          JSON.stringify(status),
          id,
        ]);
      },
      prune: async (beforeMs) => {
        await sql.run(
          `DELETE FROM openmatter_registrations
           WHERE (finished_at_ms IS NOT NULL AND finished_at_ms < ?) OR expires_at_ms < ?`,
          [beforeMs, beforeMs],
        );
      },
    },
    calls: {
      setTools: async (sessionId, toolsJson) => {
        await sql.run(
          upsert(sql.kind, "openmatter_session_tools", ["session_id", "tools_json", "updated_at_ms"], "session_id"),
          [sessionId, toolsJson, now().getTime()],
        );
      },
      tools: async (sessionId) => {
        const [row] = await sql.rows<{ tools_json: string }>(
          `SELECT tools_json FROM openmatter_session_tools WHERE session_id = ?`,
          [sessionId],
        );
        return row?.tools_json;
      },
      announce: async (sessionId, callbackId, key) => {
        await sql.run(
          `${insertIgnore(sql.kind)} openmatter_tool_calls (callback_id, session_id, call_key, seq, created_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
          [callbackId, sessionId, callKeyDigest(key), nextSeq(now().getTime()), now().getTime()],
        );
      },
      resolve: async (callbackId, outcome) => {
        await sql.run(
          `UPDATE openmatter_tool_calls SET outcome_json = ? WHERE callback_id = ? AND outcome_json IS NULL`,
          [JSON.stringify(outcome), callbackId],
        );
      },
      claim: async (sessionId, key, claimer) => {
        const candidates = await sql.rows<{ callback_id: string }>(
          `SELECT callback_id FROM openmatter_tool_calls
           WHERE session_id = ? AND call_key = ? AND claimed_by IS NULL
           ORDER BY seq LIMIT 5`,
          [sessionId, callKeyDigest(key)],
        );
        for (const { callback_id: id } of candidates) {
          const taken = await sql.run(
            `UPDATE openmatter_tool_calls SET claimed_by = ? WHERE callback_id = ? AND claimed_by IS NULL`,
            [claimer, id],
          );
          if (taken === 1) return id;
        }
        return undefined;
      },
      outcome: async (callbackId) => {
        const [row] = await sql.rows<{ outcome_json: string | null }>(
          `SELECT outcome_json FROM openmatter_tool_calls WHERE callback_id = ?`,
          [callbackId],
        );
        return row?.outcome_json == null ? undefined : (JSON.parse(row.outcome_json) as unknown);
      },
      release: async (sessionId) => {
        await sql.run(`DELETE FROM openmatter_tool_calls WHERE session_id = ? AND claimed_by IS NULL`, [sessionId]);
      },
      forget: async (callbackId) => {
        await sql.run(`DELETE FROM openmatter_tool_calls WHERE callback_id = ?`, [callbackId]);
      },
      prune: async (beforeMs) => {
        await sql.run(`DELETE FROM openmatter_tool_calls WHERE created_at_ms < ?`, [beforeMs]);
        await sql.run(`DELETE FROM openmatter_session_tools WHERE updated_at_ms < ?`, [beforeMs]);
      },
    },
    connectionStorage: storage,
    close,
  };
};

/** One SQLite file for a single local process (development, tests). */
export const openSqliteMatterDatabase = (options: {
  readonly filename: string;
  /** Where each connection's store and inbox files go (`<dir>/<key>/`). */
  readonly connectionsDir: string;
  readonly box: SecretBox;
  readonly now?: () => Date;
}): MatterDatabase => {
  const db = new DatabaseSync(options.filename);
  db.exec("PRAGMA journal_mode = WAL");
  for (const statement of tables("sqlite")) db.exec(statement);
  // Before the tables were prefixed (same columns, same order).
  for (const [from, to] of [
    ["feishu_apps", "openmatter_feishu_apps"],
    ["gitlab_connections", "openmatter_gitlab_connections"],
    ["session_tokens", "openmatter_session_tokens"],
  ] as const) {
    const old = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(from);
    if (old !== undefined) {
      db.exec(`INSERT OR IGNORE INTO ${to} SELECT * FROM ${from}; DROP TABLE ${from};`);
    }
  }
  for (const [table, column] of addedColumns) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
  return createMatterDatabase(
    sqliteDriver(db),
    options.box,
    (key) => {
      const dir = join(options.connectionsDir, key);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return {
        store: makeSqliteStore({ filename: join(dir, "store.sqlite") }),
        inbox: makeSqliteInbox({ filename: join(dir, "inbox.sqlite") }),
      };
    },
    async () => db.close(),
    options.now ?? (() => new Date()),
  );
};

/**
 * MySQL shared by every replica. Tables are created on first use; the
 * connection stores and inboxes share the pool, partitioned by key.
 */
export const openMysqlMatterDatabase = async (options: {
  readonly url: string;
  readonly box: SecretBox;
  readonly now?: () => Date;
}): Promise<MatterDatabase> => {
  const pool = createPool({ uri: options.url, connectionLimit: 10 });
  let busy = 0;
  pool.on("acquire", () => {
    busy += 1;
  });
  pool.on("release", () => {
    busy = Math.max(0, busy - 1);
  });
  try {
    for (const statement of tables("mysql")) {
      try {
        await pool.query(statement);
      } catch (error) {
        // CREATE INDEX has no IF NOT EXISTS in MySQL 8; a second replica
        // (or a restart) finds it already there.
        if ((error as { code?: string }).code !== "ER_DUP_KEYNAME") throw error;
      }
    }
    for (const [table, column] of addedColumns) {
      try {
        await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} LONGTEXT NULL`);
      } catch (error) {
        // Added by an earlier start or another replica.
        if ((error as { code?: string }).code !== "ER_DUP_FIELDNAME") throw error;
      }
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
  return createMatterDatabase(
    mysqlDriver(pool),
    options.box,
    (key) => ({
      store: makeMysqlStore({ pool, tenantId: key }),
      inbox: makeMysqlInbox({ pool, tenantId: key }),
    }),
    async () => {
      // Let queries already running finish: mysql2 throws an uncaught error
      // when a query takes a connection the pool is ending.
      const until = Date.now() + 5_000;
      while (busy > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
      await pool.end();
    },
    options.now ?? (() => new Date()),
  );
};
