import {env,exports} from "cloudflare:workers";
import {beforeAll,expect,it,vi} from "vitest";
import main from "../../main/src/index";
const key="whsec_"+btoa("cf-main-wakeup-signing-key");
beforeAll(async()=>{await exports.default.fetch(new Request("http://localhost/health"));});
async function setup(){
 const configured={...env,API_KEY:"test-key",PLATFORM_ROOT_SECRET:"cf-entry-root-012345678901234567890",OMA_MANAGED_AGENTS_WEBHOOK_URL:"https://agent.test/__internal/work/webhook",OMA_MANAGED_AGENTS_WEBHOOK_SIGNING_KEY:key};
 const waits:Promise<unknown>[]=[];const ctx={waitUntil(p:Promise<unknown>){waits.push(p);},passThroughOnException(){}};
 async function post(path:string,body:unknown){const r=await main.fetch(new Request("https://control.test"+path,{method:"POST",headers:{"x-api-key":"test-key","content-type":"application/json"},body:JSON.stringify(body)}),configured as never,ctx as never);expect(r.status).toBeLessThan(400);return r.json() as Promise<any>;}
 const suffix=crypto.randomUUID();const agent=await post("/v1/agents",{name:"auto-entry-"+suffix,model:"cf-entry-unused-model",system:"Do not run",tools:[],_oma:{harness:"acp-sandbox",acp:{agent:{command:"/usr/local/bin/openma-pi-acp"}}}});
 const environment=await post("/v1/environments",{name:"auto-entry-"+suffix,config:{type:"cloud",networking:{type:"unrestricted"}}});
 return {post,waits,agent,environment};
}
it("actual main Session creation sends signed producer wakeup after durable Work insert",async()=>{
 const original=globalThis.fetch;const deliveries:{url:string;headers:Headers;body:any}[]=[];vi.stubGlobal("fetch",async(input:any,init:any)=>{const r=new Request(input,init);deliveries.push({url:r.url,headers:r.headers,body:await r.json()});return new Response(null,{status:200});});
 try{const f=await setup();const session=await f.post("/v1/sessions",{agent:f.agent.id,environment_id:f.environment.id,title:"wakeup-entry"});await Promise.all(f.waits);
 const row=await env.MAIN_DB.prepare("SELECT id,state FROM managed_environment_work WHERE workspace_id='default' AND session_id=?").bind(session.id).first<any>();expect(row?.state).toBe("queued");expect(deliveries).toHaveLength(1);expect(deliveries[0].url).toBe("https://agent.test/__internal/work/webhook");expect(deliveries[0].headers.get("webhook-signature")).toMatch(/^v1,/);expect(deliveries[0].body.data).toMatchObject({workspace_id:"default",id:session.id,type:"session.status_run_started"});
 }finally{vi.stubGlobal("fetch",original);}
});
it("actual main interrupt revokes queued cloud ACP Work rather than only appending input",async()=>{
 const original=globalThis.fetch;vi.stubGlobal("fetch",async()=>new Response(null,{status:200}));
 try{const f=await setup();const session=await f.post("/v1/sessions",{agent:f.agent.id,environment_id:f.environment.id,title:"interrupt-entry"});await Promise.all(f.waits);
 await f.post("/v1/sessions/"+session.id+"/events",{events:[{type:"user.interrupt"}]});
 const row=await env.MAIN_DB.prepare("SELECT state,json_extract(document,'$.stopRequestedAt') AS requested,json_extract(document,'$.stoppedAt') AS stopped FROM managed_environment_work WHERE workspace_id='default' AND session_id=?").bind(session.id).first<any>();expect(row?.state).toBe("stopped");expect(row.requested).not.toBeNull();expect(row.stopped).not.toBeNull();
 }finally{vi.stubGlobal("fetch",original);}
});
