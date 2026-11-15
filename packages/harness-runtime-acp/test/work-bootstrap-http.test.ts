import {expect,it} from "vitest";
import {createWorkBootstrapHttpClient} from "../src/work-bootstrap-http.js";
const claim={workspaceId:"ws",environmentId:"env",sessionId:"s",workId:"w",generation:2,holder:"worker"};
const root={inputId:"i",turnId:"t",position:{revision:1,index:0}};
it("reads the trusted bootstrap scope with empty body and no selectors",async()=>{
 const client=createWorkBootstrapHttpClient({apiBaseUrl:"https://host",sessionId:"s",environmentId:"env",workId:"w",sessionsToken:"secret",fetch:async(raw,init)=>{
  const req=new Request(raw,init);expect(req.url).toBe("https://host/v1/oma/sessions/s/work-bootstrap");expect(await req.json()).toEqual({});expect(req.headers.get("authorization")).toBe("Bearer secret");
  return Response.json({type:"run",claim,root,revision:3});
 }});expect(await client.read(new AbortController().signal)).toEqual({type:"run",claim,root,revision:3});
});
it.each(["scope","holder","root","receipt","status"])("rejects invalid %s bootstrap authority",async fault=>{
 const value:any={type:"run",claim:{...claim},root:{...root},revision:3};
 if(fault==="scope")value.claim.workId="successor";
 if(fault==="holder")value.claim.holder="";
 if(fault==="root")value.root.position={revision:4,index:0};
 if(fault==="receipt"){value.type="cleanup-only";value.terminal={turnId:"wrong"};}
 const client=createWorkBootstrapHttpClient({apiBaseUrl:"https://host",sessionId:"s",environmentId:"env",workId:"w",sessionsToken:"secret",fetch:async()=>Response.json(value,{status:fault==="status"?503:200})});
 await expect(client.read(new AbortController().signal)).rejects.toThrow(/bootstrap/i);
});
