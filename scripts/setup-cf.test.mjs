import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "jsonc-parser";

const repositoryRoot = resolve(import.meta.dirname, "..");
const configs = ["main", "agent", "integrations"].map(app => `apps/${app}/wrangler.jsonc`);
const shared = ["PLATFORM_ROOT_SECRET", "INTEGRATIONS_INTERNAL_SECRET"];

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "cf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["scripts/setup-cf.sh", ...configs]) {
    await mkdir(resolve(root, path, ".."), { recursive: true });
    await copyFile(join(repositoryRoot, path), join(root, path));
  }
  if (!options.missingDependencies) await symlink(join(repositoryRoot, "node_modules"), join(root, "node_modules"), "dir");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "package.json"), '{"type":"commonjs"}');
  const statePath = join(root, "state.json");
  await writeFile(statePath, JSON.stringify({ calls: [], deployed: {}, secrets: {}, queues: [], ...options }));
  const fake = `#!${process.execPath}
const fs = require('fs');
const {parse} = require(${JSON.stringify(join(repositoryRoot, "node_modules/jsonc-parser"))});
const path = require('path');
const statePath = process.env.CF_TEST_STATE;
const s = JSON.parse(fs.readFileSync(statePath));
const bin = path.basename(process.argv[1]);
let a = process.argv.slice(2);
if (bin === 'npx') { if (a[0] === '--no-install') a.shift(); if (a.shift() !== 'wrangler') throw Error('not wrangler'); }
s.calls.push([bin, ...a]);
const save = () => fs.writeFileSync(statePath, JSON.stringify(s));
const fail = message => { save(); console.error(message); process.exit(1); };
const out = value => { save(); console.log(typeof value === 'string' ? value : JSON.stringify(value)); };
const cfgPath = a[a.indexOf('--config') + 1];
const cfg = a.includes('--config') ? (['.json','.jsonc'].includes(path.extname(cfgPath)) ? parse(fs.readFileSync(cfgPath, 'utf8')) : {}) : null;
const app = cfgPath?.split('/')[1];
const name = cfg?.name;
if (bin === 'npx' && process.env.CI !== 'true') fail('Wrangler must not open unattended stdin prompts');
if (bin === 'npx' && ((a[0] === 'd1' && a[1] === 'create') || (a[0] === 'kv' && a[2] === 'create')) && !a.includes('--update-config=false')) fail('resource CLI must not rewrite configs itself');
if (bin === 'pnpm') { if (s.buildFailure) fail('console build failed'); out('built'); }
else if (bin === 'docker') out('Docker ready');
else if (a[0] === 'whoami') out('You are logged in. Account ID: 11111111111111111111111111111111' + (s.multiAccount ? ' Account ID: 22222222222222222222222222222222' : ''));
else if (a[0] === 'd1' && a[1] === 'create') {
  if (s.existingResources || s.ambiguousD1) fail('already exists');
  out('database_id = "' + (a[2] === 'openma-auth' ? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') + '"');
} else if (a[0] === 'd1' && a[1] === 'list') out(s.ambiguousD1 ? [{name:'openma-auth',uuid:'a'}, {name:'openma-auth',uuid:'b'}] : [{name:'openma-auth',uuid:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}, {name:'openma-integrations',uuid:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}]);
else if (a[0] === 'kv' && a[2] === 'create') { if(s.existingResources || s.ambiguousKV) fail('already exists'); out({id:'cccccccccccccccccccccccccccccccc'}); }
else if (a[0] === 'kv' && a[2] === 'list') out(s.ambiguousKV ? [{title:'CONFIG_KV',id:'a'}, {title:'CONFIG_KV',id:'b'}] : [{title:'CONFIG_KV',id:'cccccccccccccccccccccccccccccccc'}]);
else if (a[0] === 'd1' && a[1] === 'migrations') { if (s.migrationFailure) fail('migration failed'); if(cfg.d1_databases.some(x => x.database_id.includes('<'))) fail('unpatched database'); out('No migrations to apply.'); }
else if (a[0] === 'deployments' && a[1] === 'status') { if(s.statusFailure) fail('permission denied'); if(!s.deployed[name]) fail('The Worker ' + name + ' has no deployments.'); out({versions:[{version_id:'test-version',percentage:100}]}); }
else if (a[0] === 'secret' && a[1] === 'list') {
  if (s.secretListFailure) fail('authentication denied');
  if (!s.secrets[name]) fail('Worker "' + name + '" not found.\\nIf this is a new Worker, run \u0060wrangler deploy\u0060 first to create it.');
  out(Object.keys(s.secrets[name]).map(name => ({name,type:'secret_text'})));
} else if (a[0] === 'secret' && a[1] === 'put') {
  s.secrets[name] ||= {};
  s.secrets[name][a[2]] = fs.readFileSync(0,'utf8').trim(); out('secret set');
} else if (a[0] === 'queues' && a[1] === 'list') {
  if(s.queueProfileLine) console.log(s.queueProfileLine);
  if(s.queueListFailure) fail('queue query denied');
  if(s.queueMalformed) { out('unrecognized output'); process.exit(0); }
  const rows = s.ambiguousQueue ? [{queue_name:'managed-agents-memory-events',queue_id:'a'.repeat(32)},{queue_name:'managed-agents-memory-events',queue_id:'b'.repeat(32)}] : s.queues;
  const page=Number(a[a.indexOf('--page')+1]);
  const visible=rows.slice((page-1)*1,page*1);
  out(['┌──┬──┐','│ id │ name │',...visible.map(q=>'│ '+q.queue_id+' │ '+q.queue_name+' │'),'└──┴──┘'].join('\\n'));
} else if (a[0] === 'queues' && a[1] === 'create') {
  if(s.queueCreateFailure) fail('queue create denied');
  if(s.queues.some(q=>q.queue_name===a[2])) fail('queue already exists');
  s.queues.push({queue_name:a[2],queue_id:String(s.queues.length+1).padStart(32,'0')});out('created queue');
} else if (a[0] === 'deploy') {
  if(!cfg.main && !cfg.assets) fail('Missing entry-point to Worker script or to assets directory');
  for(const consumer of cfg.queues?.consumers || []) for(const queue of [consumer.queue,consumer.dead_letter_queue].filter(Boolean)) if(!s.queues.some(q=>q.queue_name===queue)) fail('Queue '+queue+' does not exist');
  if (s.deployFailure === app) fail('deploy failed');
  for (const binding of cfg.services || []) if(!s.deployed[binding.service]) fail('missing service ' + binding.service);
  for (const binding of cfg.durable_objects?.bindings || []) if(binding.script_name && !s.deployed[binding.script_name]) fail('missing DO script');
  s.deployed[name] = true;
  s.deployConfigs ||= []; s.deployConfigs.push({path:cfgPath, config:cfg});
  out('Uploaded ' + name + (s.noURL ? '' : '\\nhttps://' + name + '.real-subdomain.workers.dev'));
} else if (a[0] === 'r2') { if(s.notificationFailure && a.includes('notification')) fail('notification failed'); out('R2 ready'); }
else fail('unexpected invocation ' + a.join(' '));
`;
  for (const command of ["npx", "pnpm", "docker"]) {
    await writeFile(join(bin, command), fake);
    await chmod(join(bin, command), 0o755);
  }
  const run = (args = ["--yes"], env = {}, input = "") => spawnSync("bash", ["scripts/setup-cf.sh", ...args], {
    cwd: root, env: { ...process.env, ANTHROPIC_API_KEY: "", PLATFORM_ROOT_SECRET: "", INTEGRATIONS_INTERNAL_SECRET: "", BETTER_AUTH_SECRET: "", API_KEY: "", CLOUDFLARE_ACCOUNT_ID: "", ...env, PATH: `${bin}:${process.env.PATH}`, CF_TEST_STATE: statePath }, input, encoding: "utf8", timeout: 20000,
  });
  return { root, run, state: async () => JSON.parse(await readFile(statePath, "utf8")), config: async app => parse(await readFile(join(root, `apps/${app}/wrangler.jsonc`), "utf8")) };
}
const output = r => r.stdout + r.stderr;
const success = r => assert.equal(r.status, 0, output(r));

test("fresh setup builds Console, resolves service/DO cycles, patches MAIN_DB and uses deployment receipts", async t => {
  const f = await fixture(t);
  success(f.run());
  for (const app of ["main", "agent", "integrations"]) assert.equal((await f.config(app)).d1_databases.find(x => x.binding === "MAIN_DB").database_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  assert.equal((await f.config("main")).vars.INTEGRATIONS_ORIGIN, "https://managed-agents-integrations.real-subdomain.workers.dev");
  assert.equal((await f.config("integrations")).vars.GATEWAY_ORIGIN, "https://managed-agents-integrations.real-subdomain.workers.dev");
  assert.equal((await f.config("main")).vars.DISABLE_AUTH, undefined);
  const s = await f.state();
  assert(s.calls.some(c => c[0] === "pnpm" && c[1] === "build:console"));
  assert(s.deployConfigs.some(c => c.path.startsWith("apps/main/.wrangler.setup.")));
  assert(s.deployConfigs.some(c => c.path.startsWith("apps/integrations/.wrangler.setup.")));
  for (const key of shared) assert.equal(new Set(Object.values(s.secrets).map(v => v[key])).size, 1);
  assert(!s.calls.some(c => c.includes("ANTHROPIC_API_KEY")));
});

test("rerun preserves secrets and avoids bootstrap of existing workers", async t => {
  const f = await fixture(t);
  success(f.run()); const before = await f.state();
  success(f.run()); const after = await f.state();
  assert.deepEqual(after.secrets, before.secrets);
  assert.equal(after.calls.filter(c => c.includes("put")).length, before.calls.filter(c => c.includes("put")).length);
  assert.equal(after.deployConfigs.filter(c => c.path.includes(".wrangler.setup.")).length, 2);
});

test("existing resource IDs are reused", async t => { const f = await fixture(t, {existingResources:true}); success(f.run()); });
for (const [option, message] of [["secretListFailure", /secret list|authentication denied/i], ["multiAccount", /account/i], ["ambiguousD1", /ambiguous|multiple/i], ["ambiguousKV", /ambiguous|multiple/i], ["migrationFailure", /migration/i], ["buildFailure", /build/i], ["notificationFailure", /notification/i], ["noURL", /URL|origin/i]]) {
  test(`${option} fails closed without reporting completion`, async t => {
    const f = await fixture(t, {[option]:true}); const r = f.run();
    assert.notEqual(r.status, 0, output(r)); assert.match(output(r), message); assert.doesNotMatch(output(r), /Done./);
  });
}
test("partial shared secret refuses to invent an unreadable existing value", async t => {
  const f = await fixture(t, { secrets:{'managed-agents':{PLATFORM_ROOT_SECRET:'keep'}} }); const r = f.run();
  assert.notEqual(r.status, 0); assert.match(output(r), /PLATFORM_ROOT_SECRET.*(partial|read|existing)/i);
  assert(!(await f.state()).calls.some(c => c.includes("put")));
});
test("explicit shared value repairs missing copies without replacing existing secrets", async t => {
  const f = await fixture(t, { secrets:{'managed-agents':{PLATFORM_ROOT_SECRET:'keep'}} }); success(f.run(["--yes"], {PLATFORM_ROOT_SECRET:'keep'}));
  for (const value of Object.values((await f.state()).secrets)) assert.equal(value.PLATFORM_ROOT_SECRET,'keep');
});
test("--yes does not authorize destructive root secret reset", async t => {
  const f = await fixture(t); const r = f.run(["--yes", "--reset-secrets"]);
  assert.notEqual(r.status,0); assert.match(output(r),/decrypt|root|danger/i); assert.equal((await f.state()).calls.length,0);
});
test("headless invocation without flags explains --yes instead of reading stdin", async t => {
  const f = await fixture(t); const r = f.run([]); assert.notEqual(r.status,0); assert.match(output(r), /--yes/); assert.equal((await f.state()).calls.length,0);
});
test("unknown flags and missing installed dependencies fail before cloud calls", async t => {
  const f = await fixture(t,{missingDependencies:true}); const unknown=f.run(["--bogus"]); assert.notEqual(unknown.status,0); assert.match(output(unknown), /Unknown flag/);
  const missing=f.run(); assert.notEqual(missing.status,0); assert.match(output(missing), /pnpm install|dependencies/i); assert.equal((await f.state()).calls.length,0);
});
test("--no-deploy provisions and migrates but never builds or deploys", async t => {
  const f = await fixture(t); success(f.run(["--yes","--no-deploy"])); const s=await f.state();
  assert(s.calls.some(c=>c.includes("migrations"))); assert(!s.calls.some(c=>c.includes("deploy") || c[0]==="pnpm"));
  const help=f.run(["--help"]); success(help); assert.match(output(help), /not a dry.run/i);
});
test("failed worker deployment stops before completion and notification", async t => {
  const f=await fixture(t,{deployFailure:'agent'}); const r=f.run(); assert.notEqual(r.status,0); assert.doesNotMatch(output(r),/Done./); assert(!(await f.state()).calls.some(c=>c.includes('notification')));
});
test("environment model key is not uploaded or assigned to a workspace", async t => {
  const f=await fixture(t); success(f.run(['--yes'],{ANTHROPIC_API_KEY:'test-key'}));
  assert(!(await f.state()).calls.some(c=>c.includes('ANTHROPIC_API_KEY')));
});

test("deployment status permission failures do not trigger bootstrap", async t => {
  const f=await fixture(t,{secrets:{'managed-agents':{},'sandbox-default':{},'managed-agents-integrations':{}},statusFailure:true});
  const r=f.run(); assert.notEqual(r.status,0); assert.match(output(r),/status|permission/i); assert(!(await f.state()).calls.some(c=>c.includes('deploy')));
});
test("provision-only drafts can be deployed on a later rerun without replacing secrets", async t => {
  const f=await fixture(t); success(f.run(['--yes','--no-deploy'])); const before=await f.state(); success(f.run()); assert.deepEqual((await f.state()).secrets,before.secrets);
});
test("web-generated no-flag command deploys without asking for a model key", async t => {
  const f=await fixture(t);
  // A real PTY is required: BSD script cannot attach to spawnSync's socket stdin.
  const driver = [
    'import os, pty, sys',
    'pid, fd = pty.fork()',
    'if pid == 0: os.execvp("bash", ["bash", "scripts/setup-cf.sh"])',
    'os.write(fd, b"y\\n")',
    'while True:',
    ' try: data = os.read(fd, 65536)',
    ' except OSError: break',
    ' if not data: break',
    ' os.write(1, data)',
    '_, status = os.waitpid(pid, 0)',
    'sys.exit(os.waitstatus_to_exitcode(status))',
  ].join('\n');
  const r=spawnSync('python3',['-c',driver],{cwd:f.root,env:{...process.env,ANTHROPIC_API_KEY:'',PLATFORM_ROOT_SECRET:'',INTEGRATIONS_INTERNAL_SECRET:'',CLOUDFLARE_ACCOUNT_ID:'',PATH:join(f.root,'bin')+':'+process.env.PATH,CF_TEST_STATE:join(f.root,'state.json')},encoding:'utf8',timeout:20000});
  success(r); assert.doesNotMatch(output(r),/Model setup:|Anthropic API key:/); assert(!(await f.state()).calls.some(c=>c.includes('ANTHROPIC_API_KEY')));
});

test("bootstrap config is JSONC and queues exist before consumer deployment", async t => {
  const f=await fixture(t); success(f.run()); const s=await f.state();
  assert.deepEqual(s.queues.map(q=>q.queue_name).sort(),['managed-agents-memory-events','managed-agents-memory-events-dlq']);
  for(const d of s.deployConfigs) assert(d.path.endsWith('.jsonc'));
});
test("interrupted integrations bootstrap recovers after main failure", async t => {
  const f=await fixture(t,{deployFailure:'main'}); assert.notEqual(f.run().status,0);
  const s=await f.state(); delete s.deployFailure; await writeFile(join(f.root,'state.json'),JSON.stringify(s));
  success(f.run()); const after=await f.state(); assert.equal(after.deployConfigs.at(-1).config.services[0].service,'managed-agents');
});
for(const option of ['queueListFailure','queueMalformed','ambiguousQueue','queueCreateFailure']) test(option+' stops before deployments',async t=>{
  const f=await fixture(t,{[option]:true}); const r=f.run(); assert.notEqual(r.status,0); assert.match(output(r),/queue|ambiguous/i); assert(!(await f.state()).calls.some(c=>c[1]==='deploy'));
});
test("existing model secrets survive setup even with an environment model key", async t=>{
  const f=await fixture(t,{secrets:{'managed-agents':{ANTHROPIC_API_KEY:'keep-model-key'}}});
  success(f.run(['--yes'],{ANTHROPIC_API_KEY:'must-not-upload'}));
  assert.equal((await f.state()).secrets['managed-agents'].ANTHROPIC_API_KEY,'keep-model-key');
  assert(!(await f.state()).calls.some(c=>c.includes('ANTHROPIC_API_KEY')));
});

test("queue reuse exhausts pages and never recreates an existing queue",async t=>{
  const f=await fixture(t);success(f.run());const before=await f.state();success(f.run());const after=await f.state();
  assert.equal(after.calls.filter(c=>c[1]==='queues'&&c[2]==='create').length,2);
  assert(after.calls.slice(before.calls.length).some(c=>c[1]==='queues'&&c[2]==='list'&&c.at(-1)==='3'));
});

test("named Wrangler profile metadata is accepted across fresh setup and rerun",async t=>{
  const f=await fixture(t,{queueProfileLine:'Active profile: selfhost'});success(f.run());success(f.run());
  assert.equal((await f.state()).calls.filter(c=>c[1]==='queues'&&c[2]==='create').length,2);
});
test("unknown profile-like metadata is rejected rather than treated as an empty queue list",async t=>{
  const f=await fixture(t,{queueProfileLine:'Active profile: selfhost unexpected data'});const r=f.run();assert.notEqual(r.status,0);assert.match(output(r),/Cannot parse Queue/);
  assert(!(await f.state()).calls.some(c=>c[1]==='queues'&&c[2]==='create'||c[1]==='deploy'));
});
