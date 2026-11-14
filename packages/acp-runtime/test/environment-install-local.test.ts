import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { prepareEnvironmentAcp } from "../src/environment-setup";
import { resolvePinnedAcpRegistryAgent } from "../src/acp-registry-pins";
const exec = promisify(execFile);

// Real shell/npm extraction/launcher through the shared Environment entry.
// The tarball is a tiny local fixture, not upstream ACP certification.
it.each(["pi-acp@0.1.8", "codex-acp@1.8.0"])("installs the exact Environment plan with real npm: %s", async registry => {
  const root = await mkdtemp(join(tmpdir(), "oma-acp-install-"));
  const pin = resolvePinnedAcpRegistryAgent(registry);
  const split = pin.package.lastIndexOf("@");
  const name = pin.package.slice(0, split), version = pin.package.slice(split + 1);
  const pkg = join(root, "package"); await mkdir(pkg);
  const manifest = { name, version, bin: { "fixture-agent": "cli.cjs" } };
  await writeFile(join(pkg, "package.json"), JSON.stringify(manifest));
  await writeFile(join(pkg, "cli.cjs"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({version:require("./package.json").version,args:process.argv.slice(2)}));\n', { mode: 0o755 });
  const archive = join(root, "package.tgz");
  await exec("tar", ["-czf", archive, "-C", root, "package"]);
  const bytes = await readFile(archive);
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  let corrupt = false, downloads = 0;
  const server = createServer((req, res) => {
    if (req.url === "/package.tgz") { downloads++; res.end(corrupt ? Buffer.from("broken tarball") : bytes); return; }
    if (decodeURIComponent(req.url ?? "").slice(1) !== name) { res.writeHead(404); res.end(); return; }
    const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name, "dist-tags": { latest: version }, versions: { [version]: { ...manifest, dist: { tarball: base + "/package.tgz", integrity } } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const runtime = (home: string) => ({ exec: async (command: string) => {
    const result = await exec("/bin/bash", ["-c", command], { timeout: 30_000, env: {
      PATH: process.env.PATH, HOME: home, npm_config_registry: base,
      npm_config_cache: join(home,"cache"), npm_config_audit: "false", npm_config_fund: "false",
      npm_config_update_notifier: "false", npm_config_fetch_retries: "0", npm_config_fetch_timeout: "5000",
    } }); return result.stdout;
  } });
  try {
    const home = join(root,"good"); await mkdir(home);
    const prepared = await prepareEnvironmentAcp({sessionId:"fixture",agent:{registry},runtime:runtime(home)});
    expect(prepared!.harness).toEqual({id:pin.id,version:pin.version});
    expect(JSON.parse(prepared!.inventory)).toEqual([{id:pin.id,version:pin.version,command:prepared!.launch.command}]);
    const result = await runtime(home).exec(`'${prepared!.launch.command}' continued`);
    expect(JSON.parse(result)).toEqual({version,args:[...pin.args,"continued"]});
    expect(downloads).toBeGreaterThan(0);
    corrupt = true;
    const bad = join(root,"bad"); await mkdir(bad);
    await expect(prepareEnvironmentAcp({sessionId:"fixture",agent:{registry},runtime:runtime(bad)})).rejects.toThrow(/integrity|prefetch|install/i);
    await expect(access(join(bad,".oma","installed-agent",pin.id,pin.version,"acp-launch.sh"))).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await rm(root,{recursive:true,force:true});
  }
},60_000);
