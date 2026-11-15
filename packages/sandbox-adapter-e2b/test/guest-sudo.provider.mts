/** Explicit owned provider diagnostic. No template publication or inference.
 * Old helper can be supplied as OMA_AGENT_EXEC_SOURCE for a meaningful RED.
 */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Sandbox} from '../../../apps/main-node/node_modules/e2b/dist/index.mjs';
import {E2BSandboxExecutor} from '../src/e2b';
import {prepareGuestSudo} from '../template/template.mjs';
const apiKey=process.env.E2B_API_KEY,template=process.env.OMA_E2B_TEMPLATE,out=process.env.OMA_SUDO_RECEIPT;
if(!apiKey||!template||!out)throw Error('Explicit task key/template/receipt required');
const base=new URL('../template/',import.meta.url),helper=readFileSync(process.env.OMA_AGENT_EXEC_SOURCE??new URL('agent-exec.py',base));
const spawner=readFileSync(new URL('agent-spawner.mjs',base));
const commonPath=new URL('../../acp-runtime/node_modules/@openma/common/',import.meta.url);
const common=JSON.parse(readFileSync(new URL('package.json',commonPath),'utf8'));assert.equal(common.version,'0.14.0');
const nativeSpawner=readFileSync(new URL('dist/acp-runtime/spawners/node.js',commonPath));
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const r:any={startedAt:new Date().toISOString(),template,kind:'fresh owned guest build-command/production managed tool and harness-spawner check; not a rebuilt official image or deployment',helperSha256:sha(helper),spawnerSha256:sha(spawner),commonVersion:common.version,commonSpawnerSha256:sha(nativeSpawner)};
const save=()=>writeFileSync(out,JSON.stringify(r,null,2)+'\n');save();let box:Sandbox|undefined;
const probe=`import os,json,subprocess,sys
status={k:v.strip() for k,v in (line.split(':',1) for line in open('/proc/self/status') if ':' in line) if k in ['Uid','Gid','NoNewPrivs','CapInh','CapPrm','CapEff','CapBnd','CapAmb','Seccomp','Seccomp_filters']}
direct=False
try: os.setuid(0); direct=True
except PermissionError: pass
sudo=subprocess.run(['/usr/bin/sudo','-n','/usr/bin/id','-u'],capture_output=True,text=True)
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'directSetuid':direct,'status':status,'sudo':{'code':sudo.returncode,'stdout':sudo.stdout.strip(),'stderr':sudo.stderr.strip()},'inheritedManagement': 'SYNTHETIC_WORK_TOKEN' in os.environ}),flush=True)
line=sys.stdin.readline()
if line: print(line.strip(),flush=True)
`;
try{
 box=await Sandbox.create(template,{apiKey,timeoutMs:180000,metadata:{task:'pr545-task-e2e4t-20261112',purpose:'functional-sudo-policy-validation'}});r.sandboxId=box.sandboxId;save();const runtime=new E2BSandboxExecutor(box as never,{managedBootstrap:{}});
 r.originalTool=await runtime.run('id -u; sudo -n id -u; grep -E "^(NoNewPrivs|Cap|Seccomp)" /proc/self/status');save();
 // Build-validation stage of this fresh, unused fixture only. This is the
 // exact official template policy, never repair an existing Session VM.
 r.provision=await box.commands.run('apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo\n'+prepareGuestSudo,{user:'root',timeoutMs:90000});assert.equal(r.provision.exitCode,0);save();
 const dir='/opt/oma-sudo-validation';await box.commands.run('install -d -m 700 '+dir,{user:'root'});
 for(const [name,bytes] of [['agent-exec.py',helper],['agent-spawner.mjs',spawner],['common-node.mjs',nativeSpawner]] as const)await box.files.write(dir+'/'+name,bytes,{user:'root'});
 await box.files.write('/workspace/sudo-probe.py',probe,{user:'root'});
 r.files=await box.commands.run("stat -c '%u:%g:%a %n' /usr/bin/sudo /etc/sudoers.d/oma-worker; visudo -cf /etc/sudoers.d/oma-worker; grep -E '^(NoNewPrivs|Cap|Seccomp)' /proc/self/status",{user:'root'});save();
 r.tool=await runtime.run('/usr/bin/python3 /workspace/sudo-probe.py </dev/null');const tool=JSON.parse(r.tool.stdout.trim());assert.notEqual(tool.uid,0);assert.equal(tool.directSetuid,false);assert.equal(tool.sudo.code,0);assert.equal(tool.sudo.stdout,'0');save();
 const driver=`import {NodeSpawner} from './common-node.mjs';
import {isolateE2BAgentSpawner} from './agent-spawner.mjs';
import {writeFile} from 'node:fs/promises';
const child=await isolateE2BAgentSpawner(new NodeSpawner()).spawn({command:'/usr/bin/python3',args:['/workspace/sudo-probe.py'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/oma-worker'}});
const collect=async s=>{let text='';for await(const b of s)text+=new TextDecoder().decode(b);return text;};
const stdout=collect(child.stdout),stderr=collect(child.stderr);const w=child.stdin.getWriter();await w.write(new TextEncoder().encode('ACP-local-stdio\\n')).catch(()=>{});await w.close().catch(()=>{});
const result={stdout:await stdout,stderr:await stderr,exit:await child.exited};await writeFile('${dir}/result.json',JSON.stringify(result));`;
 await box.files.write(dir+'/driver.mjs',driver,{user:'root'});
 const handle=await runtime.startManagedProcess({command:'/usr/local/bin/node',args:[dir+'/driver.mjs'],cwd:dir,env:{PATH:'/usr/local/bin:/usr/bin:/bin',SYNTHETIC_WORK_TOKEN:'nonsecret-inheritance-negative-control'}});
 for(let i=0;i<200&&await handle.getStatus()!=='exited';i++)await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(await handle.getStatus(),'exited');r.harness=JSON.parse(await box.files.read(dir+'/result.json',{user:'root'}));save();
 const lines=r.harness.stdout.trim().split('\n');const child=JSON.parse(lines[0]);r.harnessObserved=child;save();assert.notEqual(child.uid,0);assert.equal(child.directSetuid,false);assert.equal(child.inheritedManagement,false);assert.equal(child.sudo.code,0,'production harness launch must retain functional sudo');assert.equal(child.sudo.stdout,'0');assert.equal(child.status.NoNewPrivs,'0');assert.equal(lines[1],'ACP-local-stdio');assert.equal(r.harness.exit.code,0);
 // An outer NNP restriction must be diagnosed, never silently produce a
 // decorative sudo package or change the provider/host security controls.
 const nnpDriver=driver.replace('/result.json','/nnp-result.json');
 await box.files.write(dir+'/driver-nnp.mjs',nnpDriver,{user:'root'});
 const denied=await runtime.startManagedProcess({command:'/usr/bin/setpriv',args:['--no-new-privs','/usr/local/bin/node',dir+'/driver-nnp.mjs'],cwd:dir,env:{PATH:'/usr/local/bin:/usr/bin:/bin'}});
 for(let i=0;i<200&&await denied.getStatus()!=='exited';i++)await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(await denied.getStatus(),'exited');r.inheritedNnp=JSON.parse(await box.files.read(dir+'/nnp-result.json',{user:'root'}));assert.notEqual(r.inheritedNnp.exit.code,0);assert.match(r.inheritedNnp.stderr,/Guest sudo unavailable: inherited no_new_privs/);save();
 const capDriver=driver.replace('/result.json','/cap-result.json');
 await box.files.write(dir+'/driver-cap.mjs',capDriver,{user:'root'});
 const capDenied=await runtime.startManagedProcess({command:'/usr/bin/setpriv',args:['--bounding-set=-all','/usr/local/bin/node',dir+'/driver-cap.mjs'],cwd:dir,env:{PATH:'/usr/local/bin:/usr/bin:/bin'}});
 for(let i=0;i<200&&await capDenied.getStatus()!=='exited';i++)await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(await capDenied.getStatus(),'exited');r.inheritedCaps=JSON.parse(await box.files.read(dir+'/cap-result.json',{user:'root'}));assert.notEqual(r.inheritedCaps.exit.code,0);assert.match(r.inheritedCaps.stderr,/Guest sudo unavailable: inherited capability bounding set/);save();
 // Explicit elevation can read a synthetic root-private sentinel. This is
 // intentional evidence that guest UID isolation is no longer a boundary.
 await box.files.write(dir+'/synthetic-private','NOT_A_REAL_CREDENTIAL',{user:'root'});
 r.explicitRoot=await runtime.run('sudo -n cat '+dir+'/synthetic-private');assert.equal(r.explicitRoot.stdout.trim(),'NOT_A_REAL_CREDENTIAL');
 r.status='PASS_FUNCTIONAL_GUEST_SUDO_TOOLS_AND_PRODUCTION_HARNESS_SPAWNER';
}catch(e){r.status='FAIL';r.error={name:(e as Error).name,message:(e as Error).message};process.exitCode=1;}
finally{if(box)try{r.paused=await box.betaPause();}catch(e){r.pauseError=(e as Error).name;}r.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:r.status,sandboxId:r.sandboxId,paused:r.paused}));}
