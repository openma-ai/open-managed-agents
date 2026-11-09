import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSubprocessSandbox } from "../../../packages/sandbox/src/adapters/local-subprocess";
import { clearSandboxEgress } from "../../../packages/sandbox-egress/src/install";
import { localRelayFixture } from "./helpers/local-relay-fixture";
const run = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
const fixture = (cliId?: "gh" | "glab", realCli = false) => localRelayFixture(cleanup, cliId, realCli);
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("sandbox-owned local credential relay", () => {
  it("two local Sessions run relays concurrently, and each restart retains its allocated proxy port", async () => {
    const a = await fixture(); const b = await fixture();
    const [one, two] = await Promise.all([a.prepare(), b.prepare()]);
    expect(one.port).not.toBe(two.port);
    for (const f of [a, b]) expect(await f.sandbox.exec(`curl -sS --noproxy '' -o /dev/null -w '%{http_code}' '${f.target}/concurrent'`)).toBe("200");
    await clearSandboxEgress(a.sandbox);
    const reattached = new LocalSubprocessSandbox({ workdir: a.workdir });
    cleanup.push(() => reattached.destroy());
    expect(await reattached.egressRelayPort()).toBe(one.port);
    const again = await a.prepare();
    expect(again.port).toBe(one.port);
    expect(await b.sandbox.exec(`curl -sS --noproxy '' -o /dev/null -w '%{http_code}' '${b.target}/still'`)).toBe("200");
  });

  it("runs a real CLI via localhost and ordinary HTTPS relay with placeholders only in the client", async () => {
    const f = await fixture(); await f.prepare();
    const output = await f.sandbox.exec(`printf '%s\\n' "$GITHUB_TOKEN"; curl -sS --noproxy '' -H "Authorization: Bearer $GITHUB_TOKEN" '${f.target}/a%2Fb?q=one%20two' | od -An -tu1`);
    expect(output).toContain("__cap_managed__"); expect(output).toMatch(/0\s+255\s+128/); expect(output).not.toContain("real-token");
    expect(f.seen).toHaveLength(1); expect(f.seen[0]).toMatchObject({ token: "Bearer real-token", path: "/a%2Fb?q=one%20two" });
    expect(f.seen[0]!.headers).not.toHaveProperty("proxy-authorization");
  });

  it.each([
    { cliId: "glab" as const, alias: "PRIVATE-TOKEN" },
    { cliId: "gh" as const, alias: "X-Github-Token" },
  ])("removes $cliId protocol placeholder aliases at the real TLS upstream", async ({ cliId, alias }) => {
    // Only the endpoint is redirected to the fixture; strip/set rules are the
    // builtin CLI spec, and TLS is verified with the sandbox-generated CA.
    const f = await fixture(cliId); await f.prepare();
    const output = await f.sandbox.exec(`curl -sS --max-time 3 --noproxy '' -H '${alias}: __cap_managed__' -H 'Authorization: Bearer __cap_managed__' '${f.target}/user' | od -An -tu1`);
    expect(output).toMatch(/0\s+255\s+128/); expect(f.seen).toHaveLength(1);
    expect(f.seen[0]!.token).toBe("Bearer real-token");
    expect(f.seen[0]!.headers).not.toHaveProperty(alias.toLowerCase());
    expect(JSON.stringify(f.seen[0]!.headers)).not.toContain("__cap_managed__");
  });

  it("runs the installed gh CLI against the credential relay without exposing its token", async context => {
    const available = await run("sh", ["-c", "command -v gh || true"]);
    if (!available.stdout.trim()) { context.skip(); return; }
    const f = await fixture("gh", true); await f.prepare();
    // Preserve the real hostname/spec; only the control-plane upstream
    // transport routes this synthetic request to the local TLS fixture.
    const output = await f.sandbox.exec(`GH_CONFIG_DIR='${f.dir}/gh-config' GH_PROMPT_DISABLED=1 gh api --hostname github.com user --silent`, 10000);
    expect(output).not.toContain("[exit"); expect(output).not.toContain("real-token");
    expect(f.seen).toHaveLength(1); expect(f.seen[0]!.token).toBe("Bearer real-token");
    expect(JSON.stringify(f.seen[0]!.headers)).not.toContain("__cap_managed__");
  });

  it("preserves a credential-matched HEAD representation length without sending a body", async () => {
    const f = await fixture(); await f.prepare();
    const output = await f.sandbox.exec(`curl -sS --max-time 3 --noproxy '' -I '${f.target}/head'`);
    expect(output).toContain("200 OK"); expect(output).toContain("content-length: 123"); expect(output).toContain("x-head: yes");
    expect(output).not.toContain("curl:"); expect(output).not.toContain("x-oma-egress-");
    expect(f.seen).toHaveLength(1); expect(f.seen[0]!.token).toBe("Bearer real-token");
  });

  it.each([204, 205, 304])("preserves bodyless %s status and representation metadata", async status => {
    const f = await fixture(); f.setStatus(status); await f.prepare();
    const output = await f.sandbox.exec(`curl -sS --max-time 3 --noproxy '' -D - '${f.target}/empty'`);
    expect(output).toContain(`HTTP/1.1 ${status}`); expect(output).toContain("x-empty: yes"); expect(output).not.toContain("curl:");
    if (status === 304) expect(output).toContain("content-length: 123");
    expect(output).not.toContain("x-oma-egress-");
  });

  it("preserves 307 location without following the redirect", async () => {
    const f = await fixture(); await f.prepare();
    const output = await f.sandbox.exec(`curl -sS --max-time 3 --noproxy '' -D - '${f.target}/redirect'`);
    expect(output).toContain("307 Temporary Redirect"); expect(output).toContain("location: /next");
    expect(f.seen).toHaveLength(1); expect(f.seen[0]!.path).toBe("/redirect");
  });

  it("keeps gzip content encoding, encoded length and actual bytes consistent", async () => {
    const f = await fixture(); await f.prepare();
    const headers = await f.sandbox.writeFile("gzip.headers", "");
    const output = await f.sandbox.exec(`curl -sS --max-time 3 --noproxy '' -D '${headers}' '${f.target}/gzip' | base64`);
    const expected = gzipSync(Buffer.from([0, 255, 128]));
    expect(Buffer.from(output.trim(), "base64")).toEqual(expected);
    const metadata = await readFile(headers, "utf8");
    expect(metadata).toContain("content-encoding: gzip"); expect(metadata).toContain(`content-length: ${expected.length}`);
  });

  it("delivers the first response chunk before the delayed tail", async () => {
    const f = await fixture(); await f.prepare();
    const headers = await f.sandbox.writeFile("stream.headers", "");
    const output = await f.sandbox.exec(`curl -sS --max-time 4 --noproxy '' -N -D '${headers}' -w '\\nTIMES:%{time_starttransfer}|%{time_total}' '${f.target}/stream'`);
    expect(output).toContain("firstlast");
    const times = /TIMES:([\d.]+)\|([\d.]+)/u.exec(output)!;
    expect(times).not.toBeNull(); expect(Number(times[2]) - Number(times[1])).toBeGreaterThan(0.9);
    const metadata = await readFile(headers, "utf8");
    expect(metadata).toContain("206 Partial Content"); expect(metadata.match(/set-cookie:/gu)).toHaveLength(2);
  });

  it("replays binary POST only on successful refresh and rechecks current Vaults and archive state", async () => {
    const f = await fixture(); await f.prepare(); f.setStatus(401);
    const bodyPath = await f.sandbox.writeFile("payload.b64", "AP8BgA==");
    const call = () => f.sandbox.exec(`base64 -d < '${bodyPath}' | curl -sS --noproxy '' -o /dev/null -w '%{http_code}' -X POST --data-binary @- '${f.target}/binary?q=1'`);
    expect(await call()).toContain("200"); expect(f.refreshes).toBe(1); expect(f.seen).toHaveLength(2);
    expect(f.seen.map(row => row.body)).toEqual([Buffer.from([0,255,1,128]), Buffer.from([0,255,1,128])]);
    f.setVaults([]); expect(await call()).toContain("403"); expect(f.seen).toHaveLength(2);
    f.setVaults(["vault"]); f.archive(); expect(await call()).toMatch(/401|502/); expect(f.seen).toHaveLength(2);
  });

  it.each([401, 403])("does not resend failed refresh or forbidden %s", async status => {
    const f = await fixture(); await f.prepare(); f.setStatus(status); f.failRefresh();
    await f.sandbox.exec(`curl -sS --noproxy '' -o /dev/null '${f.target}/'`);
    expect(f.seen).toHaveLength(1); expect(f.refreshes).toBe(status === 401 ? 1 : 0);
  });

  it("tunnels a no-match HTTPS host locally without control-plane injection", async () => {
    const f = await fixture(); f.setVaults([]); await f.prepare();
    const trust = await f.sandbox.writeFile("direct-trust.crt", f.upstreamPem);
    expect(await f.sandbox.exec(`curl -sS --noproxy '' --cacert '${trust}' -H 'Authorization: Bearer direct-only' -o /dev/null -w '%{http_code}' '${f.target}/direct'`)).toContain("200");
    expect(f.seen).toHaveLength(1); expect(f.seen[0]!.token).toBe("Bearer direct-only"); expect(f.refreshes).toBe(0);
  });

  it("denies a token whose execution attempt ended (401) without dialing the upstream", async () => {
    const f = await fixture(); await f.prepare(); f.settle();
    expect(await f.sandbox.exec(`curl -sS --noproxy '' '${f.target}/expired' 2>&1 || true`)).toContain("401");
    expect(f.seen).toHaveLength(0);
  });

  it("a gateway that cannot check (503) fails only the request; the forwarder keeps serving", async () => {
    const f = await fixture(); const ready = await f.prepare(); f.tokens.fail();
    expect(await f.sandbox.exec(`curl -sS --noproxy '' '${f.target}/down' 2>&1 || true`)).toMatch(/503|502/);
    f.tokens.fail(false);
    expect(await f.sandbox.exec(`curl -sS --noproxy '' -o /dev/null -w '%{http_code}' '${f.target}/back'`)).toContain("200");
    expect(() => process.kill(ready.pid!, 0)).not.toThrow();
  });

  it("the token reaches the relay through one file that it deletes: no file under .oma-egress holds it", async () => {
    const f = await fixture(); await f.prepare(); await f.prepare(); // same-sandbox redelivery is consumed too
    expect(await f.sandbox.exec(`curl -sS --noproxy '' -o /dev/null -w '%{http_code}' '${f.target}/'`)).toContain("200");
    const listing = await f.sandbox.exec("ls -A .oma-egress");
    expect(listing).not.toMatch(/binding\./u);
    expect(f.issued).toHaveLength(1);
    for (const token of f.issued) expect(await f.sandbox.exec(`grep -rlF '${token}' .oma-egress || echo NONE`)).toContain("NONE");
    const ready = JSON.parse(await f.sandbox.exec("cat .oma-egress/ready.json")) as Record<string, unknown>;
    expect(ready).toMatchObject({ protocol: 4, bindingError: null });
    expect(Object.keys(ready).sort()).toEqual(["bindingError", "bindingId", "caBundleFile", "caFile", "pid", "port", "protocol"]);
  });

  it("a malformed delivery never replaces the working binding and is reported; the installer fails", async () => {
    const f = await fixture(); const ready = await f.prepare();
    await f.sandbox.exec(`printf '%s' '{"endpoint":"http://plain"}' > .oma-egress/binding.json && chmod 600 .oma-egress/binding.json`);
    // Deletion precedes the readiness write; wait for the externally visible
    // rejection, not merely the file disappearing between those two steps.
    let state!: { bindingError: string | null; pid: number };
    for (let i = 0; i < 50; i++) {
      state = JSON.parse(await f.sandbox.exec("cat .oma-egress/ready.json"));
      if (state.bindingError !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(state.bindingError).toMatch(/binding rejected/);
    expect(state.pid).toBe(ready.pid);
    expect(await f.sandbox.exec(`curl -sS --noproxy '' -o /dev/null -w '%{http_code}' '${f.target}/still'`)).toContain("200");
  });

  it("a relay started with no delivery exits with an error instead of running without a binding", async () => {
    const f = await fixture(); await f.prepare();
    await f.sandbox.exec("node -e \"process.kill(JSON.parse(require('fs').readFileSync('.oma-egress/ready.json')).pid,'SIGTERM')\"; sleep 0.3");
    const output = await f.sandbox.exec("node .oma-egress/relay.cjs \"$PWD/.oma-egress\" 2>&1; echo EXIT=$?");
    expect(output).toContain("has no binding"); expect(output).toContain("EXIT=1");
  });

  it("clears the proxy environment and closes the local listener on Vault removal", async () => {
    const f = await fixture(); const ready = await f.prepare();
    await clearSandboxEgress(f.sandbox);
    expect(await f.sandbox.exec('printf "%s|%s|%s" "$GITHUB_TOKEN" "$HTTPS_PROXY" "$NODE_EXTRA_CA_CERTS"')).toBe("||");
    await expect(run("curl", ["--noproxy", "*", "--retry", "0", "--max-time", "2", `http://127.0.0.1:${ready.port}/health`])).rejects.toThrow();
  });

  it("uses independent sandbox CAs and repairs a killed warm relay before commands run", async () => {
    const f = await fixture(); const a = await f.prepare();
    const b = new LocalSubprocessSandbox({ workdir: join(f.dir, "sandbox-b") }); cleanup.push(() => b.destroy());
    await clearSandboxEgress(f.sandbox);
    const other = await f.prepare(b);
    expect(await readFile(a.caFile!, "utf8")).not.toBe(await readFile(other.caFile!, "utf8"));
    expect(await b.exec(`curl -sS --noproxy '' -o /dev/null -w '%{http_code}' '${f.target}/'`)).toContain("200");
    await clearSandboxEgress(b);
    const restarted = await f.prepare();
    await run("kill", ["-KILL", String(restarted.pid)]);
    const repaired = await f.prepare(); expect(repaired.pid).not.toBe(restarted.pid);
    expect(await f.sandbox.exec(`curl -sS --noproxy '' -o /dev/null -w '%{http_code}' '${f.target}/warm'`)).toContain("200");
  });
});
