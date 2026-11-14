/** Offline normal-loader gate. Requires verified, complete official installs;
 * never downloads packages, invokes inference, or inherits provider secrets. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { kimiCodeInferenceAdapter } from "../packages/harness-inference-adapters/src/adapters/kimi";
import { opencodeInferenceAdapter } from "../packages/harness-inference-adapters/src/adapters/opencode";
import type { InferenceWireProtocol } from "../packages/acp-runtime/src/inference/types";
const exec = promisify(execFile);
const [kimiPackage, opencodeBinary] = process.argv.slice(2).map(p => resolve(p));
assert(kimiPackage && opencodeBinary, "Usage: node scripts/check-official-harness-loaders.mjs <kimi-code-2.6.0-package-dir> <opencode-1.2.21-binary>");
const kimi = join(kimiPackage, "dist/main.mjs");
const manifest = JSON.parse(await readFile(join(kimiPackage,"package.json"),"utf8"));
assert.equal(manifest.name,"@moonshot-ai/kimi-code"); assert.equal(manifest.version,"2.6.0");
const hash = async (path:string) => createHash("sha256").update(await readFile(path)).digest("hex");
assert.equal(await hash(kimi),"cb912b23358e7b3160e95dc29a82bf5ddd3847cd6f287b34c00c80d80284b620");
assert.equal(await hash(opencodeBinary),"d480918f23dbca3b06b3607266fecfbf26d55736691291cb4ed71c495b62ee41");
const root = await mkdtemp(join(tmpdir(),"oma-official-loaders-"));
const results: object[] = [];
const protocols = { "anthropic-messages":"anthropic", "openai-responses":"openai/v1", gemini:"gemini" };
try {
  for (const adapter of [kimiCodeInferenceAdapter,opencodeInferenceAdapter]) for (const [protocol,proxyPathSegment] of Object.entries(protocols)) {
    const home = join(root,adapter.id,protocol); await mkdir(home,{recursive:true});
    const plan = adapter.plan({nativePath:home,agent:{id:adapter.id,command:adapter.id},
      target:{wireModel:"chosen-model",providerId:"custom",protocolEndpoints:[]},
      proxy:{proxyBaseUrl:"https://proxy.invalid/v1/oma/inference-proxy/test-session",proxyToken:"synthetic-token",proxyTokenEnvVar:"HOSTED_INFERENCE_TOKEN"},
      protocol:protocol as InferenceWireProtocol,endpoint:{protocol:protocol as InferenceWireProtocol,proxyPathSegment,upstreamBaseUrl:"https://upstream.invalid"}});
    for(const file of plan.files ?? []) {await mkdir(dirname(file.path),{recursive:true});await writeFile(file.path,file.content);}
    const env: Record<string,string> = {PATH:"/usr/local/bin:/usr/bin:/bin",HOME:home,HOSTED_INFERENCE_TOKEN:"synthetic-token",...plan.env};
    if(adapter.id === "kimi-code") {
      env.KIMI_DISABLE_TELEMETRY="true";
      await exec("unshare",["-Urn",process.execPath,kimi,"doctor","config"],{cwd:home,env,timeout:30_000});
      const loaded=JSON.parse((await exec("unshare",["-Urn",process.execPath,kimi,"provider","list","--json"],{cwd:home,env,timeout:30_000})).stdout);
      assert.deepEqual(loaded.providers.oma,{baseUrl:`https://proxy.invalid/v1/oma/inference-proxy/test-session/${proxyPathSegment}`,type:{"anthropic-messages":"anthropic","openai-responses":"openai_responses",gemini:"google-genai"}[protocol],apiKeyEnv:"HOSTED_INFERENCE_TOKEN"});
      assert.deepEqual(loaded.models.oma,{provider:"oma",model:"chosen-model",maxContextSize:262144});
      await writeFile(plan.files![0]!.path,"[providers.oma\n");
      await assert.rejects(exec("unshare",["-Urn",process.execPath,kimi,"doctor","config"],{cwd:home,env,timeout:30_000}),error => (error as {code?:number}).code === 1);
    } else {
      Object.assign(env,{XDG_CONFIG_HOME:join(home,"config"),XDG_DATA_HOME:join(home,"data"),XDG_CACHE_HOME:join(home,"cache"),XDG_STATE_HOME:join(home,"state"),OPENCODE_DISABLE_AUTOUPDATE:"1",OPENCODE_DISABLE_DEFAULT_PLUGINS:"1",OPENCODE_DISABLE_MODELS_FETCH:"1",OPENCODE_DISABLE_LSP_DOWNLOAD:"1",OPENCODE_DISABLE_PROJECT_CONFIG:"1",OPENCODE_DISABLE_CLAUDE_CODE:"1",OPENCODE_DISABLE_EXTERNAL_SKILLS:"1"});
      const config=join(home,"config/opencode"); await mkdir(config,{recursive:true});
      // Genuine upstream flags disable network features; a read-only config
      // mount also prevents its implicit dependency installer from starting.
      const args=["-Urnm","/bin/sh","-c",'mount --bind "$1" "$1" && mount -o remount,bind,ro "$1" && shift && exec "$@"',"sh",config,opencodeBinary,"debug","config"];
      const loaded=JSON.parse((await exec("unshare",args,{cwd:home,env,timeout:30_000})).stdout);
      const expected=JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT!); expected.provider.oma.options.apiKey="synthetic-token";
      for(const key of ["provider","model","small_model"]) assert.deepEqual(loaded[key],expected[key]);
      env.OPENCODE_CONFIG_CONTENT=JSON.stringify({model:123});
      await assert.rejects(exec("unshare",args,{cwd:home,env,timeout:30_000}),error => (error as {code?:number}).code === 1);
    }
    results.push({adapter:adapter.id,protocol,normalLoader:"passed",rejectingNegative:"passed"});
  }
  console.log(JSON.stringify({officialVersions:{kimi:"2.6.0",opencode:"1.2.21"},network:"isolated namespace",inferenceCalls:0,results},null,2));
} finally { await rm(root,{recursive:true,force:true}); }
