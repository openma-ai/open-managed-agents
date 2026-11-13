/** Opt-in owned provider gate; no model calls or template publication. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createNodeE2BSessionAdapter} from '../src/e2b-session-adapter';
import {configureNodeNativeStorage} from '../../../packages/control-plane-node/src/lib/work-finalization-host/native-storage';
const output=process.env.OMA_E2B_OUTPUT_RECEIPT, template=process.env.OMA_E2B_TEMPLATE;
if(!output||!template||!process.env.E2B_API_KEY)throw Error('explicit task credentials/template/receipt required');
const r:any={template,startedAt:new Date().toISOString(),sessionId:'pr545-task-e2e4t-20261112-native-'+crypto.randomUUID()};const save=()=>writeFileSync(output,JSON.stringify(r,null,2)+'\n');save();
const a=await createNodeE2BSessionAdapter({...process.env,E2B_MAX_LIFETIME_MS:'3600000'},60000);let runtime:any;
try{
 const acquired=await a.adapter.lifecycle.acquire({plan:{from:{image:template},idleMs:60000,labels:{task:'pr545-task-e2e4t-20261112',purpose:'native-owner-gate'}},signal:new AbortController().signal} as any);assert.notEqual(acquired,'gone');if(acquired==='gone')throw Error('allocation gone');runtime=acquired.runtime;r.sandboxId=acquired.handle.runtimeId;save();
 const bucket={endpoint:process.env.MEMORY_S3_ENDPOINT!,bucketName:process.env.MEMORY_S3_BUCKET!,accessKey:process.env.MEMORY_S3_ACCESS_KEY!,secretKey:process.env.MEMORY_S3_SECRET_KEY!,usePathRequestStyle:true};
 configureNodeNativeStorage(runtime,bucket);
 await runtime.mountSessionOutputs({tenantId:'default',sessionId:r.sessionId});
 r.identity=await runtime.run("id -u; id -g; stat -c '%u:%g' /mnt/session/outputs");save();const ids=r.identity.stdout.trim().split('\n');assert.equal(ids[2],ids[0]+':'+ids[1],'native mount owner must equal effective tool UID/GID');
 r.write=await runtime.run('set -eu; printf NATIVE_OWNED_BYTES > /mnt/session/outputs/proof.txt; cat /mnt/session/outputs/proof.txt; test ! -r /run/oma-rclone');assert.equal(r.write.exitCode,0);save();
 await runtime.drainNodeWorkStorage({workspaceId:'default',session:{id:r.sessionId,resources:[]},workAuthority:{isCurrent:async()=>true}});r.drained=true;
 await runtime.mountMemoryStore({storeName:'readonly',storeId:'session-outputs/default/'+r.sessionId,readOnly:true});
 r.readonly=await runtime.run('cat /mnt/memory/readonly/proof.txt; printf forbidden > /mnt/memory/readonly/proof.txt');assert.notEqual(r.readonly.exitCode,0);assert.ok(r.readonly.stdout.includes('NATIVE_OWNED_BYTES'));r.status='PASS_NATIVE_MOUNT_OWNER_WRITE_DRAIN_READONLY';
}catch(e){r.status='FAIL';if(runtime)r.mountDiagnostic=await runtime.run('rclone version; ls -l /dev/fuse; tail -20 /run/oma-rclone/session_outputs/mount.log',{user:'root',sessionEnv:false}).catch(()=>null);r.error={name:(e as Error).name,message:(e as Error).message};process.exitCode=1;}
finally{if(runtime)try{await runtime.suspend({kind:'memory'});r.paused=true;}catch(e){r.pauseError=(e as Error).name;}r.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:r.status,sandboxId:r.sandboxId,paused:r.paused}));}
