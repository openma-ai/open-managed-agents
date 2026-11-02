// Deployment-configured OpenID Connect sign-in, end to end against a local
// mock provider: discovery, PKCE authorization, callback, token exchange,
// userinfo, user and workspace creation, and the session cookie.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";

import { validateOidcSignInProviders } from "@open-managed-agents/auth-config";
import { listAuthProviders } from "@open-managed-agents/shared";

import { loadNodeConfig, type NodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import {
  createBetterAuthComponent,
  nodeDefaults,
  openNodeDatabase,
  type OidcSignInProvider,
} from "../src/components";

const BASE = "http://localhost:8080";
const created: NodeControlPlane[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testConfig(): NodeConfig {
  const dir = mkdtempSync(join(tmpdir(), "oma-oidc-"));
  dirs.push(dir);
  return loadNodeConfig({
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
    PUBLIC_BASE_URL: BASE,
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
  });
}

interface MockProvider {
  issuer: string;
  tokenRequests: URLSearchParams[];
  /** Profile fields the provider returns next to the fixed identity. */
  profile: { name: string; picture?: string };
}

/** A minimal OpenID provider: discovery, token, and userinfo. */
async function startMockProvider(): Promise<MockProvider> {
  const tokenRequests: URLSearchParams[] = [];
  const profile: MockProvider["profile"] = { name: "Ada Lovelace" };
  const server = createServer((req, res) => {
    const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/.well-known/openid-configuration") {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/keys`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (req.url === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        tokenRequests.push(form);
        const code = form.get("code");
        if (code === "id-token-code") {
          // Claims in an ID token from the back channel; no userinfo call needed.
          const claims = {
            iss: issuer,
            sub: "corp-user-7",
            aud: "client-1",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
            email: "grace@corp.example",
            name: "Grace Hopper",
            ...(profile.picture ? { picture: profile.picture } : {}),
          };
          const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
          return json(200, {
            access_token: "at-without-userinfo",
            token_type: "Bearer",
            expires_in: 3600,
            id_token: `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`,
          });
        }
        if (code !== "good-code") return json(400, { error: "invalid_grant" });
        json(200, { access_token: "at-1", token_type: "Bearer", expires_in: 3600 });
      });
      return;
    }
    if (req.url === "/userinfo") {
      if (req.headers.authorization !== "Bearer at-1") return json(401, { error: "invalid_token" });
      return json(200, {
        sub: "corp-user-42",
        email: "ada@corp.example",
        email_verified: true,
        ...profile,
      });
    }
    json(404, { error: "not_found" });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { issuer, tokenRequests, profile };
}

function provider(issuer: string): OidcSignInProvider {
  return {
    id: "corp",
    name: "Corp SSO",
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    clientId: "client-1",
    clientSecret: "secret-1",
  };
}

/** Folds Set-Cookie headers into one Cookie header. */
function cookieJar(previous: string, response: Response): string {
  const jar = new Map(
    previous
      .split("; ")
      .filter(Boolean)
      .map((c) => [c.slice(0, c.indexOf("=")), c] as const),
  );
  for (const set of response.headers.getSetCookie()) {
    const pair = set.split(";")[0]!;
    jar.set(pair.slice(0, pair.indexOf("=")), pair);
  }
  return [...jar.values()].join("; ");
}

async function boot(oidc: OidcSignInProvider[], emailPassword: boolean) {
  const config = testConfig();
  const database = await openNodeDatabase(config.database);
  const auth = await createBetterAuthComponent({
    config,
    database,
    email: null,
    signIn: { oidc, emailPassword },
  });
  const cp = await createNodeControlPlane(await nodeDefaults(config, { database, auth }));
  created.push(cp);
  return { cp, database, auth, config };
}

/** Runs the authorization-code flow once and returns the session cookies. */
async function signInOnce(cp: NodeControlPlane, code: string): Promise<string> {
  const start = await cp.fetch(
    new Request(`${BASE}/auth/sign-in/oauth2`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ providerId: "corp", callbackURL: "/" }),
    }),
  );
  const cookies = cookieJar("", start);
  const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state")!;
  const callback = await cp.fetch(
    new Request(`${BASE}/auth/oauth2/callback/corp?code=${code}&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookies },
    }),
  );
  expect(callback.headers.get("location")).toBe("/");
  return cookieJar(cookies, callback);
}

/** Reads the user row from the separate SQLite auth database. */
function storedUser(config: NodeConfig, email: string) {
  const db = new Database(config.auth.databasePath, { readonly: true });
  try {
    const user = db.prepare(`SELECT id, name, image FROM "user" WHERE email = ?`).get(email) as
      | { id: string; name: string; image: string | null }
      | undefined;
    const accounts = user
      ? (db.prepare(`SELECT COUNT(*) AS n FROM account WHERE "userId" = ?`).get(user.id) as { n: number }).n
      : 0;
    return { user, accounts };
  } finally {
    db.close();
  }
}

describe("OIDC sign-in wire point", () => {
  it("stores the provider's picture URL and refreshes it on every sign-in", async () => {
    const idp = await startMockProvider();
    const { cp, config } = await boot([provider(idp.issuer)], false);

    idp.profile.picture = "https://avatars.example/ada-1.png";
    await signInOnce(cp, "good-code");
    const first = storedUser(config, "ada@corp.example").user;
    expect(first?.image).toBe("https://avatars.example/ada-1.png");

    idp.profile.picture = "https://avatars.example/ada-2.png";
    idp.profile.name = "Ada King";
    await signInOnce(cp, "good-code");
    const second = storedUser(config, "ada@corp.example");
    expect(second.user).toEqual({ id: first!.id, name: "Ada King", image: "https://avatars.example/ada-2.png" });
    expect(second.accounts).toBe(1);
  });

  it("refreshes the picture from ID token claims on a repeat sign-in", async () => {
    const idp = await startMockProvider();
    const { cp, config, auth } = await boot([provider(idp.issuer)], false);

    idp.profile.picture = "https://avatars.example/grace-1.png";
    await signInOnce(cp, "id-token-code");
    idp.profile.picture = "https://avatars.example/grace-2.png";
    const cookies = await signInOnce(cp, "id-token-code");

    const stored = storedUser(config, "grace@corp.example");
    expect(stored.user).toMatchObject({ name: "Grace Hopper", image: "https://avatars.example/grace-2.png" });
    expect(stored.accounts).toBe(1);
    expect(await auth.resolveSession(new Headers({ cookie: cookies }))).toMatchObject({ email: "grace@corp.example" });
  });

  it("keeps the stored picture when a later sign-in carries none", async () => {
    const idp = await startMockProvider();
    const { cp, config } = await boot([provider(idp.issuer)], false);

    idp.profile.picture = "https://avatars.example/ada-1.png";
    await signInOnce(cp, "good-code");
    delete idp.profile.picture;
    await signInOnce(cp, "good-code");
    expect(storedUser(config, "ada@corp.example").user?.image).toBe("https://avatars.example/ada-1.png");
  });

  it("signs a user in through a configured provider and creates their workspace", async () => {
    const idp = await startMockProvider();
    const { cp, database, auth } = await boot([provider(idp.issuer)], false);

    const info = (await (await cp.fetch(new Request(`${BASE}/auth-info`))).json()) as {
      providers: string[];
      oidc: { id: string; name: string }[];
      email_password: boolean;
    };
    expect(info.providers).toEqual([]);
    expect(info.oidc).toEqual([{ id: "corp", name: "Corp SSO" }]);
    expect(info.email_password).toBe(false);

    const start = await cp.fetch(
      new Request(`${BASE}/auth/sign-in/oauth2`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ providerId: "corp", callbackURL: "/" }),
      }),
    );
    expect(start.status).toBe(200);
    let cookies = cookieJar("", start);
    const authorize = new URL(((await start.json()) as { url: string }).url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${idp.issuer}/authorize`);
    expect(authorize.searchParams.get("client_id")).toBe("client-1");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/oauth2/callback/corp`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toBe("openid profile email");
    const state = authorize.searchParams.get("state")!;

    const callback = await cp.fetch(
      new Request(`${BASE}/auth/oauth2/callback/corp?code=good-code&state=${encodeURIComponent(state)}`, {
        headers: { cookie: cookies },
      }),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");
    cookies = cookieJar(cookies, callback);

    const exchange = idp.tokenRequests.at(-1)!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("client_secret")).toBe("secret-1");
    expect(exchange.get("code_verifier")).toBeTruthy();

    const session = await auth.resolveSession(new Headers({ cookie: cookies }));
    expect(session).toMatchObject({ email: "ada@corp.example", name: "Ada Lovelace" });
    const membership = await database.sql
      .prepare(`SELECT role FROM membership WHERE user_id = ?`)
      .bind(session!.userId)
      .first<{ role: string }>();
    expect(membership?.role).toBe("owner");

    const agents = await cp.fetch(
      new Request(`${BASE}/v1/agents`, {
        headers: { cookie: cookies, "anthropic-beta": "managed-agents-2026-04-01" },
      }),
    );
    expect(agents.status).toBe(200);
  });

  it("takes the user from the ID token when the token response has one", async () => {
    const idp = await startMockProvider();
    const { cp, auth } = await boot([provider(idp.issuer)], false);
    const start = await cp.fetch(
      new Request(`${BASE}/auth/sign-in/oauth2`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ providerId: "corp", callbackURL: "/" }),
      }),
    );
    let cookies = cookieJar("", start);
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state")!;
    const callback = await cp.fetch(
      new Request(`${BASE}/auth/oauth2/callback/corp?code=id-token-code&state=${encodeURIComponent(state)}`, {
        headers: { cookie: cookies },
      }),
    );
    expect(callback.headers.get("location")).toBe("/");
    cookies = cookieJar(cookies, callback);
    expect(await auth.resolveSession(new Headers({ cookie: cookies }))).toMatchObject({
      email: "grace@corp.example",
      name: "Grace Hopper",
    });
  });

  it("refuses email sign-up when email and password are turned off", async () => {
    const idp = await startMockProvider();
    const { cp } = await boot([provider(idp.issuer)], false);
    const signUp = await cp.fetch(
      new Request(`${BASE}/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: "x@example.com", password: "password-123456", name: "X" }),
      }),
    );
    expect(signUp.status).toBeGreaterThanOrEqual(400);
    expect(signUp.status).toBeLessThan(500);
  });

  it("keeps email sign-in by default and lists both methods", async () => {
    const idp = await startMockProvider();
    const { cp } = await boot([provider(idp.issuer)], true);
    const info = (await (await cp.fetch(new Request(`${BASE}/auth-info`))).json()) as {
      providers: string[];
      oidc: unknown[];
      email_password: boolean;
    };
    expect(info.providers).toEqual(["email"]);
    expect(info.oidc).toHaveLength(1);
    expect(info.email_password).toBe(true);
  });

  it("does not sign in when the provider rejects the code", async () => {
    const idp = await startMockProvider();
    const { cp, auth } = await boot([provider(idp.issuer)], false);
    const start = await cp.fetch(
      new Request(`${BASE}/auth/sign-in/oauth2`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ providerId: "corp", callbackURL: "/" }),
      }),
    );
    let cookies = cookieJar("", start);
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state")!;
    const callback = await cp.fetch(
      new Request(`${BASE}/auth/oauth2/callback/corp?code=bad-code&state=${encodeURIComponent(state)}`, {
        headers: { cookie: cookies },
      }),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toMatch(/error/);
    cookies = cookieJar(cookies, callback);
    expect(await auth.resolveSession(new Headers({ cookie: cookies }))).toBeNull();
  });
});

describe("OIDC provider validation", () => {
  const base = provider("https://sso.example.com");

  it("accepts https and loopback http discovery URLs", () => {
    expect(() => validateOidcSignInProviders([base])).not.toThrow();
    expect(() =>
      validateOidcSignInProviders([{ ...base, discoveryUrl: "http://127.0.0.1:9/x" }]),
    ).not.toThrow();
  });

  it("rejects unsafe or ambiguous providers", () => {
    expect(() =>
      validateOidcSignInProviders([{ ...base, discoveryUrl: "http://sso.example.com/x" }]),
    ).toThrow(/https/);
    expect(() => validateOidcSignInProviders([{ ...base, id: "github" }])).toThrow(/built-in/);
    expect(() => validateOidcSignInProviders([{ ...base, id: "Corp SSO" }])).toThrow(/lowercase/);
    expect(() => validateOidcSignInProviders([base, base])).toThrow(/twice/);
    expect(() => validateOidcSignInProviders([{ ...base, clientSecret: "" }])).toThrow(/secret/);
  });

  it("drops email methods from /auth-info when email and password are off", () => {
    expect(listAuthProviders({ emailOtp: true, emailPassword: false })).toEqual([]);
    expect(listAuthProviders({ emailOtp: true })).toEqual(["email", "email-otp"]);
  });
});
