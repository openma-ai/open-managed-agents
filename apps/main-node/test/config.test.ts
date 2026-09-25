// loadNodeConfig is the only place the Node control plane reads environment
// variables. It turns the flat string bag into typed data once, applies the
// documented defaults, and reports every problem in one error.

import { describe, expect, it } from "vitest";

import { loadNodeConfig, redactNodeConfig, type NodeConfig } from "../src/config";

const minimal = { NODE_ENV: "test" };

describe("loadNodeConfig", () => {
  it("applies the self-host defaults when nothing is set", () => {
    const config = loadNodeConfig(minimal);

    expect(config.processMode).toBe("standalone");
    expect(config.database).toEqual({ kind: "sqlite", path: "./data/oma.db" });
    expect(config.auth).toMatchObject({ disabled: false, databasePath: "./data/auth.db", requireEmailVerify: false });
    expect(config.auth.secret).toBeUndefined();
    expect(config.blobs.memory).toEqual({ kind: "localfs", dir: "./data/memory-blobs" });
    expect(config.blobs.files).toEqual({ kind: "localfs", dir: "./data/files-blobs" });
    expect(config.memoryQueue).toBe("auto");
    expect(config.realtime).toEqual({ mode: "memory", pollIntervalMs: 300 });
    expect(config.execution.concurrency).toBe(8);
    expect(config.execution.ownerId).toMatch(/^node:\d+:/);
    expect(config.paths).toEqual({ sandboxWorkdir: "./data/sandboxes", sessionOutputs: "./data/session-outputs" });
    expect(config.http).toEqual({ host: "0.0.0.0", port: 8787, gatewayOrigin: "http://localhost:8787", publicBaseUrl: undefined, consoleDir: undefined, metricsToken: undefined, apiKey: undefined });
    expect(loadNodeConfig({ ...minimal, HOST: "127.0.0.1", PORT: "18787" }).http).toMatchObject({ host: "127.0.0.1", port: 18787 });
    expect(loadNodeConfig({ ...minimal, PORT: "0" }).http.port).toBe(0);
    expect(() => loadNodeConfig({ ...minimal, PORT: "70000" })).toThrow(/PORT must be an integer between 0 and 65535/);
    expect(config.tunnels.domainSuffix).toBe("tunnels.localhost");
    expect(config.email).toBeNull();
    expect(config.feishuWsRunner).toBe(false);
    expect(config.dreamCurator).toBe("model");
    expect(config.cron).toEqual({
      evalTick: "* * * * *",
      memoryRetention: "* * * * *",
      webhookEventsRetention: "* * * * *",
      linearDispatch: "* * * * *",
    });
    expect(config.sandbox.environment).toBe(minimal);
  });

  it("selects the database and realtime fanout from DATABASE_URL", () => {
    const pg = loadNodeConfig({ ...minimal, DATABASE_URL: "postgres://u:p@h:5432/db" });
    expect(pg.database).toEqual({ kind: "postgres", url: "postgres://u:p@h:5432/db" });
    expect(pg.realtime.mode).toBe("pg-notify");

    const mysql = loadNodeConfig({ ...minimal, DATABASE_URL: "mysql://u:p@h:3306/db", OMA_REALTIME_POLL_INTERVAL_MS: "500" });
    expect(mysql.database).toEqual({ kind: "mysql", url: "mysql://u:p@h:3306/db" });
    expect(mysql.realtime).toEqual({ mode: "sql-poll", pollIntervalMs: 500 });
  });

  it("reads S3 blob backends only when all four required values are present", () => {
    const partial = loadNodeConfig({ ...minimal, MEMORY_S3_ENDPOINT: "http://s3", MEMORY_S3_BUCKET: "b" });
    expect(partial.blobs.memory.kind).toBe("localfs");

    const full = loadNodeConfig({
      ...minimal,
      MEMORY_S3_ENDPOINT: "http://s3", MEMORY_S3_BUCKET: "mem", MEMORY_S3_ACCESS_KEY: "ak", MEMORY_S3_SECRET_KEY: "sk",
      MEMORY_S3_POLL_INTERVAL_SEC: "3",
      FILES_S3_ENDPOINT: "http://s3", FILES_S3_BUCKET: "files", FILES_S3_ACCESS_KEY: "ak2", FILES_S3_SECRET_KEY: "sk2", FILES_S3_REGION: "eu-west-1",
    });
    expect(full.blobs.memory).toEqual({
      kind: "s3", endpoint: "http://s3", bucket: "mem", accessKey: "ak", secretKey: "sk", region: "us-east-1",
      // MEMORY_S3_POLL_INTERVAL_SEC below 5s is clamped, as before.
      pollIntervalMs: 5_000,
    });
    expect(full.blobs.files).toEqual({ kind: "s3", endpoint: "http://s3", bucket: "files", accessKey: "ak2", secretKey: "sk2", region: "eu-west-1" });
  });

  it("parses the string-encoded flags and numbers exactly as the assembly did", () => {
    const config = loadNodeConfig({
      ...minimal,
      AUTH_DISABLED: "1", AUTH_REQUIRE_EMAIL_VERIFY: "1", FEISHU_WS_RUNNER: "1", MEMORY_QUEUE: "disabled",
      DREAM_CURATOR_MODE: "dedup", OMA_SESSION_EXECUTION_CONCURRENCY: "3", OMA_SESSION_EXECUTION_OWNER_ID: "replica-a",
      ANTHROPIC_CUSTOM_HEADERS: "X-A: 1, X-B: two:parts",
      SMTP_HOST: "smtp", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "noreply@x",
      GATEWAY_ORIGIN: "https://gw", PUBLIC_BASE_URL: "https://pub",
    });
    expect(config.auth.disabled).toBe(true);
    expect(config.auth.requireEmailVerify).toBe(true);
    expect(config.feishuWsRunner).toBe(true);
    expect(config.memoryQueue).toBe("disabled");
    expect(config.dreamCurator).toBe("dedup");
    expect(config.execution).toEqual({ concurrency: 3, ownerId: "replica-a" });
    expect(config.model.customHeaders).toEqual({ "X-A": "1", "X-B": "two:parts" });
    expect(config.email).toEqual({ host: "smtp", port: 465, secure: true, user: "u", pass: "p", fromAddress: "noreply@x" });
    expect(config.http.gatewayOrigin).toBe("https://gw");
    expect(config.http.publicBaseUrl).toBe("https://pub");
    // GATEWAY_ORIGIN falls back to PUBLIC_BASE_URL.
    expect(loadNodeConfig({ ...minimal, PUBLIC_BASE_URL: "https://pub" }).http.gatewayOrigin).toBe("https://pub");
  });

  it("reports every configuration problem at once", () => {
    let error: Error | undefined;
    try {
      loadNodeConfig({
        ...minimal,
        OPENMA_PROCESS_MODE: "cluster",
        OMA_REALTIME_FANOUT: "redis",
        OMA_SESSION_EXECUTION_CONCURRENCY: "many",
        MEMORY_S3_ENDPOINT: "http://s3", MEMORY_S3_BUCKET: "b", MEMORY_S3_ACCESS_KEY: "a", MEMORY_S3_SECRET_KEY: "s",
        MEMORY_S3_POLL_INTERVAL_SEC: "soon",
        SMTP_HOST: "smtp", SMTP_PORT: "abc",
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.name).toBe("NodeConfigError");
    expect(error?.message).toContain("5 problems");
    for (const key of ["OPENMA_PROCESS_MODE", "OMA_REALTIME_FANOUT", "OMA_SESSION_EXECUTION_CONCURRENCY", "MEMORY_S3_POLL_INTERVAL_SEC", "SMTP_PORT"]) {
      expect(error?.message.split(key).length - 1).toBe(1);
    }
  });

  it("keeps the serverless-mode requirements", () => {
    expect(() => loadNodeConfig({ ...minimal, OPENMA_PROCESS_MODE: "serverless", DATABASE_URL: "mysql://u:p@h/db" }))
      .toThrow(/DATABASE_URL must be PostgreSQL in serverless mode/);
  });
});

describe("redactNodeConfig", () => {
  it("hides secrets and credentials but keeps everything needed to recognise a deployment", () => {
    const config: NodeConfig = loadNodeConfig({
      ...minimal,
      DATABASE_URL: "mysql://qa:supersecret@db.internal:3306/openma",
      BETTER_AUTH_SECRET: "auth-secret", PLATFORM_ROOT_SECRET: "root-secret", API_KEY: "static-key",
      GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret",
      ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_BASE_URL: "https://llm",
      MEMORY_S3_ENDPOINT: "http://s3", MEMORY_S3_BUCKET: "mem", MEMORY_S3_ACCESS_KEY: "ak", MEMORY_S3_SECRET_KEY: "sk",
      SMTP_HOST: "smtp", SMTP_PASS: "smtp-pass",
      METRICS_BIND_TOKEN: "mt", INTEGRATIONS_INTERNAL_TOKEN: "it", OMA_MANAGED_AGENTS_WEBHOOK_SIGNING_KEY: "wk",
      E2B_API_KEY: "e2b-secret",
    });

    const redacted = JSON.stringify(redactNodeConfig(config));

    for (const secret of ["supersecret", "auth-secret", "root-secret", "static-key", "gsecret", "sk-ant", "\"sk\"", "smtp-pass", "\"mt\"", "\"it\"", "\"wk\"", "e2b-secret"]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("mysql://qa:***@db.internal:3306/openma");
    expect(redacted).toContain("https://llm");
    expect(redacted).toContain("\"bucket\":\"mem\"");
    expect(redacted).toContain("\"gid\"");
    expect(redacted).toContain("\"kind\":\"mysql\"");
    // The provider's own namespace is opaque to the control plane and is not echoed.
    expect(redacted).not.toContain("environment");
  });
});
