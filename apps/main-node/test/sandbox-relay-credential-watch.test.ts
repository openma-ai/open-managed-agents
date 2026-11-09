// The real relay's exit decision (#561 race table E) with a real binding
// holder on a real directory and a real `mv`: the gateway probe is a deferred
// promise, so "a new token is delivered while the 401 probe is in flight" and
// "a delivery lands after the relay decided to exit" are pinned exactly.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayBindingHolder, type RelayBinding } from "../../../packages/sandbox-egress/src/relay-binding";
import { checkRelayCredential, type RelayTokenStatus } from "../../../packages/sandbox-egress/src/relay-credential-watch";

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function relayDir() {
  const dir = await mkdtemp(join(tmpdir(), "oma-relay-watch-")); dirs.push(dir);
  const deliver = async (token: string, id: string) => {
    const staging = join(dir, `binding.${id}.next.json`);
    await writeFile(staging, JSON.stringify({ endpoint: "https://control.example", sessionId: "session", token, deliveryId: id }), { mode: 0o600 });
    await run("mv", [staging, join(dir, "binding.json")]);
  };
  return { dir, deliver, holder: createRelayBindingHolder(dir) };
}
function deferredProbe() {
  const calls: Array<{ binding: RelayBinding; answer(status: RelayTokenStatus): void }> = [];
  let called!: () => void; let next = new Promise<void>((resolve) => { called = resolve; });
  return {
    calls,
    nextCall: () => next,
    probe: (binding: RelayBinding) => new Promise<RelayTokenStatus>((answer) => { calls.push({ binding, answer }); called(); next = new Promise<void>((resolve) => { called = resolve; }); }),
  };
}

describe("relay exit decision vs a new delivery (real holder, real mv)", () => {
  it("E: a new token delivered while the 401 probe is in flight is probed before any exit; the relay stays with it", async () => {
    const r = await relayDir();
    await r.deliver("token-old", "1".padStart(24, "0")); r.holder.consume();
    const p = deferredProbe(); let exited = 0;
    const first = p.nextCall();
    const decision = checkRelayCredential({ read: () => r.holder.current(), probe: p.probe, exit: () => { exited++; r.holder.freeze(); } });
    await first;
    expect(p.calls[0]!.binding.token).toBe("token-old");
    await r.deliver("token-new", "2".padStart(24, "0")); // lands mid-probe
    const second = p.nextCall();
    p.calls[0]!.answer("invalid"); // the old token is dead (execution ended)
    await second;
    expect(p.calls[1]!.binding.token).toBe("token-new");
    p.calls[1]!.answer("valid");
    expect(await decision).toBe(false);
    expect(exited).toBe(0);
    expect(r.holder.current().token).toBe("token-new");
    expect(existsSync(join(r.dir, "binding.json"))).toBe(false);
  });

  it("E: once the relay has decided to exit it takes no delivery: the file stays for the installer, which replaces the relay (sandbox-relay-delivery-races)", async () => {
    const r = await relayDir();
    await r.deliver("token-old", "1".padStart(24, "0")); r.holder.consume();
    const p = deferredProbe(); let exited = 0;
    const first = p.nextCall();
    const decision = checkRelayCredential({ read: () => r.holder.current(), probe: p.probe, exit: () => { exited++; r.holder.freeze(); } });
    await first;
    p.calls[0]!.answer("invalid");
    expect(await decision).toBe(true);
    expect(exited).toBe(1);
    await r.deliver("token-new", "2".padStart(24, "0")); // after the exit decision
    r.holder.consume();
    expect(r.holder.peek()!.token).toBe("token-old");
    expect(existsSync(join(r.dir, "binding.json"))).toBe(true);
  });

  it("E: an unknown answer (5xx / network) never exits", async () => {
    const r = await relayDir();
    await r.deliver("token-old", "1".padStart(24, "0")); r.holder.consume();
    const p = deferredProbe(); let exited = 0;
    const first = p.nextCall();
    const decision = checkRelayCredential({ read: () => r.holder.current(), probe: p.probe, exit: () => { exited++; } });
    await first; p.calls[0]!.answer("unknown");
    expect(await decision).toBe(false); expect(exited).toBe(0);
  });
});
