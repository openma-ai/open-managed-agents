import { expect,it,vi } from "vitest";
import { createServer } from "node:http";
import { createNodeE2BSessionAdapter } from "../src/e2b-session-adapter.js";
it("Node cold finalization reader uses real installed SDK GET only, never connect/timeout",async()=>{
 const seen:string[]=[];
 const server=createServer((req,res)=>{seen.push(req.method+" "+req.url);res.setHeader("content-type","application/json");res.end(JSON.stringify({sandboxID:"physical",state:"running",lifecycle:{autoResume:false},envdVersion:"0.3.0",envdAccessToken:"test",domain:"example.test"}));});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 vi.stubEnv("E2B_API_URL",`http://127.0.0.1:${(server.address() as {port:number}).port}`);
 try{const adapter=await createNodeE2BSessionAdapter({E2B_API_KEY:"synthetic",E2B_MAX_LIFETIME_MS:"3600000"},300000);
 const runtime=await adapter.connectWorkReadonly!("physical");expect(runtime.runtimeHandle?.().runtimeId).toBe("physical");expect(seen).toEqual(["GET /sandboxes/physical"]);
 }finally{vi.unstubAllEnvs();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});
it.each(["paused","auto-resume","unknown"])("readonly connection refuses %s without sending mutation",async kind=>{
 const seen:string[]=[];const server=createServer((req,res)=>{seen.push(req.method+" "+req.url);res.setHeader("content-type","application/json");if(kind==="unknown"){res.statusCode=503;res.end('{}');return;}res.end(JSON.stringify({sandboxID:"physical",state:kind==="paused"?"paused":"running",lifecycle:{autoResume:kind==="auto-resume"},envdVersion:"0.3.0",envdAccessToken:"test"}));});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));vi.stubEnv("E2B_API_URL",`http://127.0.0.1:${(server.address() as {port:number}).port}`);
 try{const a=await createNodeE2BSessionAdapter({E2B_API_KEY:"synthetic",E2B_MAX_LIFETIME_MS:"3600000"},300000);await expect(a.connectWorkReadonly!("physical")).rejects.toThrow(/unavailable|running/);expect(seen.every(x=>x==="GET /sandboxes/physical")).toBe(true);}finally{vi.unstubAllEnvs();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});
// Gap A6: definitive provider absence is "gone" (the scheduler re-requests a
// sandbox through openSandbox); any other read failure stays an error.
it("readonly connection reports the provider's definitive absence as gone",async()=>{
 const seen:string[]=[];const server=createServer((req,res)=>{seen.push(req.method+" "+req.url);res.statusCode=404;res.setHeader("content-type","application/json");res.end(JSON.stringify({code:404,message:"sandbox \"physical\" not found"}));});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));vi.stubEnv("E2B_API_URL",`http://127.0.0.1:${(server.address() as {port:number}).port}`);
 try{const a=await createNodeE2BSessionAdapter({E2B_API_KEY:"synthetic",E2B_MAX_LIFETIME_MS:"3600000"},300000);await expect(a.connectWorkReadonly!("physical")).resolves.toBe("gone");expect(seen).toEqual(["GET /sandboxes/physical"]);}finally{vi.unstubAllEnvs();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});
it("readonly connection propagates a provider transport failure instead of reporting absence",async()=>{
 const server=createServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const port=(server.address() as {port:number}).port;
 await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));
 vi.stubEnv("E2B_API_URL",`http://127.0.0.1:${port}`);
 try{const a=await createNodeE2BSessionAdapter({E2B_API_KEY:"synthetic",E2B_MAX_LIFETIME_MS:"3600000"},300000);await expect(a.connectWorkReadonly!("physical")).rejects.toThrow();}finally{vi.unstubAllEnvs();}
});
