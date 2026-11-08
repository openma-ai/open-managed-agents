import { describe, expect, it } from "vitest";
import {
  CAP_CLI_SENTINEL, carriesVaultPlaceholder, compileVaultSubstitutions, createVaultPlaceholders, hostMatches,
  scrubVaultValues, substituteVaultPlaceholders, vaultSandboxCredentialIds, type VaultSubstitutionSecret,
} from "../src/vault-substitution";

const placeholders = createVaultPlaceholders("test-root-secret");
const scope = { workspaceId: "ws", sessionId: "sess" };
const envAuth = (name: string, value: string | null, hosts: string[] | null, body = false) => ({
  type: "environment_variable", secretName: name, secretValue: value,
  networking: hosts === null ? { type: "unrestricted" } : { type: "limited", allowedHosts: hosts },
  injectionLocation: { header: true, body },
});
const rec = (id: string, auth: { type: string }, archivedAt: string | null = null) => ({ credential: { id, archivedAt, auth } });
const specs = { byCliId: (id: string) => id === "gh" ? { endpoints: ["api.github.com"], bootstrap: { env: { GITHUB_TOKEN: CAP_CLI_SENTINEL, GH_HOST: "github.com" } } } : null };

async function secretsFor(records: ReturnType<typeof rec>[]) {
  return (await compileVaultSubstitutions({ scope, records, specs, placeholders })).secrets;
}

describe("Vault placeholders (design §8.4 rule 1)", () => {
  it("are high entropy, stable within a Session and distinct across Sessions, workspaces and credentials", async () => {
    const a = await placeholders.placeholder(scope, "cred");
    expect(a).toMatch(/^oma_vault_[A-Za-z0-9_-]{43}$/u);
    expect(await placeholders.placeholder(scope, "cred")).toBe(a);
    expect(await createVaultPlaceholders("test-root-secret").placeholder(scope, "cred")).toBe(a);
    const others = await Promise.all([
      placeholders.placeholder({ ...scope, sessionId: "other" }, "cred"),
      placeholders.placeholder({ ...scope, workspaceId: "other" }, "cred"),
      placeholders.placeholder(scope, "cred2"),
      createVaultPlaceholders("another-secret").placeholder(scope, "cred"),
    ]);
    expect(new Set([a, ...others]).size).toBe(5);
  });
});

describe("hostMatches (design §8.4b)", () => {
  it.each([
    ["api.example.com", "api.example.com", true], ["api.example.com", "API.Example.com.", true],
    ["api.example.com", "x.api.example.com", false], ["*.example.com", "a.b.example.com", true],
    ["*.example.com", "example.com", false], ["*.example.com", "badexample.com", false], ["*", "anything.test", true],
  ])("%s ~ %s → %s", (pattern, host, expected) => { expect(hostMatches(pattern, host)).toBe(expected); });
});

describe("compileVaultSubstitutions (design §0.1)", () => {
  it("compiles environment_variable and cap_cli into placeholders; plaintext only on the gateway side", async () => {
    const { secrets, env } = await compileVaultSubstitutions({ scope, specs, placeholders, records: [
      rec("cred_env", envAuth("API_TOKEN", "env-secret-value", ["api.example.com"], true)),
      rec("cred_open", envAuth("OPEN_TOKEN", "open-secret-value", null)),
      rec("cred_dup", envAuth("API_TOKEN", "later-value", ["api.example.com"])),
      rec("cred_old", envAuth("OLD", "old-value", ["x.test"]), "2026-01-01T00:00:00Z"),
      rec("cred_empty", envAuth("EMPTY", null, ["x.test"])),
      rec("cred_gh", { type: "cap_cli", cliId: "gh", token: "gh-token" } as { type: string }),
      rec("cred_mcp", { type: "static_bearer" }),
    ] });
    expect(secrets.map((s) => [s.substitution.credentialId, s.substitution.envName, s.substitution.hosts, s.substitution.inject])).toEqual([
      ["cred_env", "API_TOKEN", ["api.example.com"], { header: true, body: true }],
      ["cred_open", "OPEN_TOKEN", ["*"], { header: true, body: false }],
      ["cred_gh", "GITHUB_TOKEN", ["api.github.com"], { header: true, body: false }],
    ]);
    expect(env).toEqual({ GH_HOST: "github.com" });
    const sandboxSide = JSON.stringify(secrets.map((s) => s.substitution));
    for (const value of ["env-secret-value", "open-secret-value", "gh-token", CAP_CLI_SENTINEL]) expect(sandboxSide).not.toContain(value);
    expect(vaultSandboxCredentialIds([rec("a", { type: "environment_variable" }), rec("b", { type: "cap_cli" }), rec("c", { type: "mcp_oauth" }), rec("d", { type: "cap_cli" }, "x")])).toEqual(["a", "b"]);
    await expect(compileVaultSubstitutions({ scope, specs, placeholders, records: [rec("x", { type: "cap_cli", cliId: "nope" } as { type: string })] })).rejects.toThrow(/unknown cli_id "nope"/u);
  });
});

describe("substituteVaultPlaceholders (design §8.4 rules 2–6)", () => {
  async function fixture() {
    const secrets = await secretsFor([
      rec("cred_env", envAuth("API_TOKEN", "env-secret-value", ["api.example.com"])),
      rec("cred_body", envAuth("BODY_TOKEN", "body \"secret\"&=", ["*.body.test"], true)),
    ]);
    const [env, body] = secrets.map((s) => s.substitution.placeholder) as [string, string];
    return { secrets, env, body };
  }
  const run = (secrets: VaultSubstitutionSecret[], host: string, headers: Record<string, string>, body: string | null = null) =>
    substituteVaultPlaceholders({ host, headers: new Headers(headers), body: body === null ? null : new TextEncoder().encode(body).buffer as ArrayBuffer, secrets });
  const text = (body: ArrayBuffer | null) => body === null ? null : new TextDecoder().decode(body);

  it("replaces header placeholders only on the credential's hosts, and leaves the body unless injection_location.body", async () => {
    const f = await fixture();
    const result = run(f.secrets, "api.example.com", { authorization: `Bearer ${f.env}`, "x-api-key": f.env, "content-type": "application/json" }, JSON.stringify({ key: f.env }));
    expect(result).toMatchObject({ ok: true, credentialIds: ["cred_env"] });
    if (!result.ok) return;
    expect(result.headers.get("authorization")).toBe("Bearer env-secret-value");
    expect(result.headers.get("x-api-key")).toBe("env-secret-value");
    expect(result.substitutedHeaders.sort()).toEqual(["authorization", "x-api-key"]);
    expect(text(result.body)).toBe(JSON.stringify({ key: f.env }));
  });

  it("decodes, replaces and re-encodes Basic auth", async () => {
    const f = await fixture();
    const result = run(f.secrets, "api.example.com", { authorization: `Basic ${btoa(`x-access-token:${f.env}`)}` });
    expect(result.ok && result.headers.get("authorization")).toBe(`Basic ${btoa("x-access-token:env-secret-value")}`);
  });

  it("escapes body values for JSON and forms, and skips compressed or multipart bodies", async () => {
    const f = await fixture();
    const json = run(f.secrets, "a.body.test", { "content-type": "application/json" }, JSON.stringify({ key: f.body }));
    expect(json.ok && JSON.parse(text(json.body)!)).toEqual({ key: "body \"secret\"&=" });
    const form = run(f.secrets, "a.body.test", { "content-type": "application/x-www-form-urlencoded" }, `key=${f.body}`);
    expect(form.ok && new URLSearchParams(text(form.body)!).get("key")).toBe("body \"secret\"&=");
    for (const headers of [{ "content-type": "text/plain", "content-encoding": "gzip" }, { "content-type": "multipart/form-data; boundary=x" }]) {
      const skipped = run(f.secrets, "a.body.test", headers, `v=${f.body}`);
      expect(skipped.ok && text(skipped.body)).toBe(`v=${f.body}`);
    }
  });

  it("refuses a placeholder on a host its credential does not allow, an unknown placeholder, and signed requests", async () => {
    const f = await fixture();
    expect(run(f.secrets, "evil.test", { authorization: `Bearer ${f.env}` })).toEqual({ ok: false, rule: "credential_host_mismatch", credentialId: "cred_env" });
    expect(run(f.secrets, "api.example.com", { "content-type": "text/plain" }, `x ${f.body}`)).toEqual({ ok: false, rule: "credential_host_mismatch", credentialId: "cred_body" });
    const foreign = await placeholders.placeholder({ ...scope, sessionId: "other" }, "cred_env");
    expect(run(f.secrets, "api.example.com", { authorization: `Bearer ${foreign}` })).toEqual({ ok: false, rule: "credential_missing", credentialId: null });
    expect(run(f.secrets, "api.example.com", { authorization: "AWS4-HMAC-SHA256 Credential=x", "x-token": f.env })).toEqual({ ok: false, rule: "signed_request", credentialId: "cred_env" });
    const untouched = run(f.secrets, "evil.test", { authorization: "Bearer plain" }, "no placeholder");
    expect(untouched.ok && untouched.headers.get("authorization")).toBe("Bearer plain");
  });

  it("scrubs echoed values from response headers and detects placeholders in raw bytes", async () => {
    const f = await fixture();
    expect(scrubVaultValues(new Headers({ "x-echo": "got env-secret-value" }), f.secrets).get("x-echo")).toBe(`got ${f.env}`);
    expect(carriesVaultPlaceholder(new Headers(), new Uint8Array([0xff, ...new TextEncoder().encode(f.env)]).buffer)).toBe(true);
    expect(carriesVaultPlaceholder(new Headers({ authorization: `Basic ${btoa(`u:${f.env}`)}` }), null)).toBe(true);
    expect(carriesVaultPlaceholder(new Headers({ authorization: "Bearer __cap_managed__" }), null)).toBe(false);
  });
});
