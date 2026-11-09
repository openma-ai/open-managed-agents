// The installer must compare one snapshot of binding.json. Reading it twice
// lets the relay claim the delivery between the reads: the second read is
// null, which differs from this delivery's id, and a delivery the relay took
// was reported as "superseded by a newer delivery".
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localRelayFixture } from "./helpers/local-relay-fixture";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

// Holds the installer right after its first successful read of binding.json
// until the real relay has claimed that file: the window, made deterministic.
const PAUSE_AFTER_FIRST_READ = "'use strict';const fs=require('fs');const o=fs.readFileSync;let done=false;fs.readFileSync=function(p,...a){const r=o.call(this,p,...a);if(!done&&String(p).endsWith('/binding.json')){done=true;const t=Date.now();while(fs.existsSync(p)&&Date.now()-t<3000)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}return r};";

describe("relay delivery claimed while the installer is reading it", () => {
  it("is this delivery taken, not a newer one", async () => {
    const f = await localRelayFixture(cleanup);
    const first = await f.prepare();
    const preload = join(f.dir, "pause-after-read.cjs");
    await writeFile(preload, PAUSE_AFTER_FIRST_READ);
    await f.sandbox.setEnvVars({ NODE_OPTIONS: `--require ${preload}` });
    const second = await f.prepare();
    await f.sandbox.setEnvVars({ NODE_OPTIONS: "" });
    expect(second.pid).toBe(first.pid);
    expect(f.issued).toHaveLength(2);
  });
});
