import assert from 'node:assert/strict';
import { createManagedRuntimeHost } from '../src/host';
const scope={workspaceId:'ws',environmentId:'env',sessionId:'s',workId:'w'};
const handle={provider:'fake',runtimeId:'r'};
import {it} from "vitest";
it('collects final artifacts before pausing a retained runtime',async()=>{
 let paused=false;const trace:string[]=[];const noop=async()=>{};
 const host=createManagedRuntimeHost({ownerId:'o',heartbeatIntervalMs:100000,claims:{open:async()=>({type:'current',expiresAt:'2030-01-01',publication:null}),isCurrent:async()=>true,publish:async()=>{trace.push('publish');return {type:'published',revision:1}}},
 sandbox:{capabilities:async()=>({suspendResume:'supported',hardTerminate:'supported',runtimeCheckpoints:[]}),acquire:async()=>handle,heartbeat:async()=>({type:'alive'}),suspend:async()=>{paused=true;trace.push('pause');return handle},terminate:async()=>{trace.push('terminate');},reap:noop,inspect:async()=>({state:'running'})},
 workspace:{capabilities:async()=>({strategies:['retained_runtime']}),materialize:async()=>({bindingId:'ws',mountPath:'/workspace'}),attach:noop,checkpoint:async()=>({id:'c',contentHash:'hash',revision:1}),release:noop},
 outputs:{capabilities:async()=>({strategies:[{strategy:'final_collect',durability:'durable'}]}),prepare:async()=>({bindingId:'out',mountPath:'/mnt/session/outputs'}),attach:noop,collect:async()=>{trace.push('collect');if(paused)throw new Error('cannot execute find in paused runtime');return []},finalize:async()=>({id:'out',contentHash:'hash',entries:0}),release:noop,abort:noop},
 harnessDriver:{driverCapabilities:async()=>({drivers:['ama_worker']}),run:async()=>({type:'completed'})},orphans:{enqueue:noop,list:async()=>[],failed:noop,resolve:noop}});
 const result=await host.run({scope,claim:{generation:1,token:'fake'},profile:{workspace:{requirement:'continuable',preferredStrategies:['retained_runtime']},outputs:{requirement:'durable'},runtimeCheckpoint:'disabled',driver:{type:'ama_worker',process:{command:'fake'}}}});
 assert.equal(result.type,'completed');assert.deepEqual(trace,['collect','pause','publish']);
});
