// Delivery races of the sandbox-owned credential relay (#561 race table D,
// E, G and pause/resume), on real processes: the bundled relay
// (.oma-egress/relay.cjs), real `mv` for every hand-over, curl through the
// relay, and the real installer (prepareSandboxEgress → ENSURE_RELAY).
// Interleavings are pinned by process state, not timing: SIGSTOP / SIGCONT
// freeze the relay between steps, and a stand-in relay process (FAKE_RELAY)
// fixes the one window the real relay cannot be held in — "answered /health,
// then exited before taking the delivery". Waiting for the relay to report a
// delivery polls ready.json (an external process's progress, bounded).
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { localRelayFixture, type LocalRelayFixture } from "./helpers/local-relay-fixture";

const run = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 6000) => {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > ms) throw new Error(`timed out: ${what}`); await new Promise((resolve) => setTimeout(resolve, 20)); }
};
type Ready = { pid: number; port: number; protocol: number; caFile: string; caBundleFile: string; bindingId: string | null; bindingError: string | null };
const ready = async (f: LocalRelayFixture): Promise<Ready | null> => { try { return JSON.parse(await readFile(join(f.egressDir, "ready.json"), "utf8")); } catch { return null; } };
const deliveryId = (n: number | string) => String(n).padStart(24, "0");

/** The installer's hand-over without its wait: stage (0600) and a real `mv`. */
async function deliver(f: LocalRelayFixture, token: string, id: string) {
  const staging = join(f.egressDir, `binding.${id}.next.json`);
  await writeFile(staging, JSON.stringify({ ...f.relayConfig, sessionId: "session", token, deliveryId: id }), { mode: 0o600 });
  await run("mv", [staging, join(f.egressDir, "binding.json")]);
}
const consumed = async (f: LocalRelayFixture, id: string) => {
  await until(`relay reports ${id}`, async () => (await ready(f))?.bindingId === id && !existsSync(join(f.egressDir, "binding.json")));
  return (await ready(f))!;
};
const curl = (f: LocalRelayFixture, path = "/x") => f.sandbox.exec(`curl -sS --noproxy '' --max-time 5 -o /dev/null -w '%{http_code}' '${f.target}${path}' 2>&1 || true`);
async function noTokenOnDisk(f: LocalRelayFixture, tokens: readonly string[]) {
  expect((await readdir(f.egressDir)).filter((name) => name.startsWith("binding."))).toEqual([]);
  for (const token of tokens) expect(await f.sandbox.exec(`grep -rlF '${token}' .oma-egress || echo NONE`)).toContain("NONE");
}
async function stopRelay(f: LocalRelayFixture): Promise<Ready> {
  const state = (await ready(f))!;
  process.kill(state.pid, "SIGTERM");
  await until("relay exit", () => !alive(state.pid));
  return state;
}

/** A process standing in for the relay, in ready.json like one:
 *  exit-after-health — answers /health 200, and exits once it has answered while a delivery is on disk;
 *  exiting           — answers /health 503 (a relay closing after a 401), never takes a delivery, exits on SIGTERM;
 *  never-consumes    — answers 200 forever and never takes a delivery. */
const FAKE_RELAY = `const fs=require('fs'),http=require('http'),path=require('path');const [dir,mode,template]=process.argv.slice(1);
const pending=()=>fs.existsSync(path.join(dir,'binding.json'));
const s=http.createServer((q,r)=>{if(mode==='exiting'){r.writeHead(503);r.end('exiting');return}
const exit=mode==='exit-after-health'&&q.url==='/health'&&pending();if(exit)fs.writeFileSync(path.join(dir,'fake-answered-with-delivery-pending'),'1');
r.writeHead(200);r.end('ready',()=>{if(exit)process.exit(0)})});
process.on('SIGTERM',()=>{fs.writeFileSync(path.join(dir,'fake-sigterm'),pending()?'pending':'none');process.exit(0)});
s.listen(18080,'127.0.0.1',()=>{fs.writeFileSync(path.join(dir,'ready.json'),JSON.stringify({...JSON.parse(template),pid:process.pid,port:s.address().port}))});`;
async function fakeRelay(f: LocalRelayFixture, mode: "exit-after-health" | "exiting" | "never-consumes", template: Ready) {
  const child = spawn(process.execPath, ["-e", FAKE_RELAY, f.egressDir, mode, JSON.stringify(template)], { stdio: "ignore", detached: true });
  cleanup.push(async () => { try { process.kill(child.pid!, "SIGKILL"); } catch {} });
  await until("fake relay ready", async () => (await ready(f))?.pid === child.pid);
  return child.pid!;
}

describe("sandbox relay delivery races (real processes)", () => {
  it("an occupied loopback relay port fails explicitly and never selects another port", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(18080, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const f = await localRelayFixture(cleanup);
    await expect(f.prepare()).rejects.toThrow(/18080.*in use/);
    expect(await f.sandbox.exec('printf %s "$HTTPS_PROXY"')).toBe("");
  }, 30_000);

  it("a background client's inherited proxy reconnects after a relay restart with the next attempt token", async () => {
    const f = await localRelayFixture(cleanup); const first = await f.prepare();
    const inheritedProxy = await f.sandbox.exec('printf %s "$HTTPS_PROXY"');
    expect(await curl(f)).toBe("200");
    f.settle();
    expect(await curl(f, "/idle")).toContain("401");
    await stopRelay(f);
    f.tokens.claimNext();
    const next = await f.prepare();
    expect(next.pid).not.toBe(first.pid);
    const result = await f.sandbox.exec(
      "HTTPS_PROXY='" + inheritedProxy + "' https_proxy='" + inheritedProxy + "' curl -sS --noproxy '' --max-time 5 -o /dev/null -w '%{http_code}' '" + f.target + "/recovered' 2>&1 || true",
    );
    expect(result).toBe("200");
    expect(f.tokens.seenTokens.at(-1)).toBe(f.issued.at(-1));
  }, 30_000);

  it("D: mv racing the relay's read-and-delete, 60 rounds under a curl load that makes the relay consume before every request: always a whole binding, no read error, no file left", async () => {
    const f = await localRelayFixture(cleanup); const first = await f.prepare();
    const load = f.sandbox.exec(`while [ ! -e .stop-load ]; do curl -sS --noproxy '' --max-time 5 -o /dev/null -w '%{http_code}\\n' '${f.target}/load' >> .load-codes 2>/dev/null || echo ERR >> .load-codes; done; echo LOAD_DONE`, 120_000);
    const tokens: string[] = [];
    for (let round = 0; round < 60; round++) {
      const token = f.issued[0]!; tokens.push(token); // re-delivery is not a sandbox replacement
      await deliver(f, token, deliveryId(round));
      const state = await consumed(f, deliveryId(round));
      expect(state.bindingError).toBeNull();
      expect(state.pid).toBe(first.pid);
    }
    await writeFile(join(f.workdir, ".stop-load"), "");
    expect(await load).toContain("LOAD_DONE");
    const codes = (await readFile(join(f.workdir, ".load-codes"), "utf8")).trim().split("\n");
    expect(codes.length).toBeGreaterThan(20);
    expect(new Set(codes)).toEqual(new Set(["200"])); // a half or unreadable binding would be 401 / 502
    expect(await curl(f)).toBe("200");
    expect(f.tokens.seenTokens.at(-1)).toBe(tokens.at(-1));
    await noTokenOnDisk(f, [...f.issued, ...tokens]);
  }, 120_000);

  it("D: a delivery landing while the relay is frozen is taken whole after it resumes (rename is the only way in)", async () => {
    const f = await localRelayFixture(cleanup); const first = await f.prepare();
    process.kill(first.pid!, "SIGSTOP");
    const token = await f.tokens.issue();
    await deliver(f, token, deliveryId("frozen"));
    process.kill(first.pid!, "SIGCONT");
    expect((await consumed(f, deliveryId("frozen"))).bindingError).toBeNull();
    expect(await curl(f)).toBe("200"); expect(f.tokens.seenTokens.at(-1)).toBe(token);
    await noTokenOnDisk(f, [token]);
  }, 30_000);

  it("E: the relay answered /health, then exited before taking the new token: the installer replaces it and the new relay holds the token", async () => {
    const f = await localRelayFixture(cleanup); await f.prepare();
    const template = await stopRelay(f);
    const fake = await fakeRelay(f, "exit-after-health", template);
    const prepared = await f.prepare() as { pid: number; restarts?: number };
    expect(existsSync(join(f.egressDir, "fake-answered-with-delivery-pending"))).toBe(true); // the installer saw it healthy
    expect(alive(fake)).toBe(false);
    expect(prepared.restarts).toBe(1);
    expect(prepared.pid).not.toBe(fake);
    expect((await ready(f))!.bindingError).toBeNull();
    expect(await curl(f)).toBe("200"); expect(f.tokens.seenTokens.at(-1)).toBe(f.issued.at(-1));
    await noTokenOnDisk(f, f.issued);
  }, 30_000);

  it("E: a relay exiting after a 401 (/health 503, alive) never takes the new token: the installer stops it and starts one that does", async () => {
    const f = await localRelayFixture(cleanup); await f.prepare();
    f.settle(); expect(await curl(f, "/old")).toContain("401"); // the execution ended: 401
    const template = await stopRelay(f);
    f.tokens.claimNext(); // the next attempt
    const fake = await fakeRelay(f, "exiting", template);
    const prepared = await f.prepare() as { pid: number };
    expect(await readFile(join(f.egressDir, "fake-sigterm"), "utf8")).toBe("pending"); // stopped with the delivery untaken
    expect(alive(fake)).toBe(false); expect(prepared.pid).not.toBe(fake);
    expect(await curl(f)).toBe("200"); expect(f.tokens.seenTokens.at(-1)).toBe(f.issued.at(-1));
    await noTokenOnDisk(f, f.issued);
  }, 30_000);

  it("E: no relay takes the token: the installer fails explicitly, removes the delivery, and nothing egresses directly", async () => {
    const f = await localRelayFixture(cleanup); const first = await f.prepare();
    const template = await stopRelay(f);
    await fakeRelay(f, "never-consumes", template);
    const before = f.seen.length;
    await expect(f.prepare()).rejects.toThrow(/did not take its binding: binding was not consumed/);
    expect(existsSync(join(f.egressDir, "binding.json"))).toBe(false);
    await noTokenOnDisk(f, f.issued);
    // The proxy env still names the stopped relay's port: refused, not direct.
    expect(await f.sandbox.exec('printf %s "$HTTPS_PROXY"')).toBe(`http://127.0.0.1:${first.port}`);
    expect(await curl(f, "/after-failure")).not.toContain("200");
    expect(f.seen.length).toBe(before);
  }, 30_000);

  it("G: two deliveries land while the relay is frozen: the newest is the binding, the older never reaches memory, no file is left", async () => {
    const f = await localRelayFixture(cleanup); const first = await f.prepare();
    process.kill(first.pid!, "SIGSTOP");
    const older = await f.tokens.issue(); const newer = await f.tokens.issue();
    await deliver(f, older, deliveryId("older"));
    await deliver(f, newer, deliveryId("newer"));
    process.kill(first.pid!, "SIGCONT");
    expect((await consumed(f, deliveryId("newer"))).bindingError).toBeNull();
    expect(await curl(f)).toBe("200");
    expect(f.tokens.seenTokens).not.toContain(older);
    expect(f.tokens.seenTokens.at(-1)).toBe(newer);
    await noTokenOnDisk(f, [older, newer]);
  }, 30_000);

  it("G: two installers at once: at least one succeeds, a loser fails explicitly, the relay works and no file is left", async () => {
    const f = await localRelayFixture(cleanup); await f.prepare();
    const results = await Promise.allSettled([f.prepare(), f.prepare()]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    for (const result of results) if (result.status === "rejected") expect(String(result.reason)).toMatch(/did not take its binding: (superseded by a newer delivery|relay did not report this delivery)/);
    expect(await curl(f)).toBe("200");
    expect((await ready(f))!.bindingError).toBeNull();
    await noTokenOnDisk(f, f.issued);
  }, 30_000);

  it("pause/resume: a frozen relay keeps its in-memory binding (no file comes back); a new attempt during the pause is a hot swap in the same process", async () => {
    const f = await localRelayFixture(cleanup); const first = await f.prepare();
    process.kill(first.pid!, "SIGSTOP");
    process.kill(first.pid!, "SIGCONT");
    expect(await curl(f, "/after-resume")).toBe("200");
    expect(f.tokens.seenTokens.at(-1)).toBe(f.issued[0]);
    await noTokenOnDisk(f, f.issued);
    process.kill(first.pid!, "SIGSTOP");
    f.settle(); f.tokens.claimNext(); // the attempt ended and the next one claimed while paused
    process.kill(first.pid!, "SIGCONT");
    expect(await curl(f, "/stale")).toContain("401");
    const next = await f.prepare(); // the next execution's egress attach
    expect(next.pid).toBe(first.pid);
    expect(await curl(f, "/next")).toBe("200"); expect(f.tokens.seenTokens.at(-1)).toBe(f.issued.at(-1));
    await noTokenOnDisk(f, f.issued);
  }, 30_000);
});
