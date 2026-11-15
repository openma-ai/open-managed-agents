import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createExecutionChannelsHttpResolver } from "../src/execution-channels-http";

it("uses the existing sandbox bearer only on the existing Session channels endpoint", async () => {
  const resolve = createExecutionChannelsHttpResolver({apiBaseUrl:"https://control.test/base",fetch:async(input,init)=>{
    const request=new Request(input,init);
    expect(request.url).toBe("https://control.test/v1/oma/sessions/session%2F1/execution-channels");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer oma_sbx_test-only");
    expect(await request.json()).toEqual({});
    return Response.json({type:"failed",phase:"token_validation",code:"token_rejected",message:"stale claim"});
  }});
  expect(await resolve({tenantId:"tenant",sessionId:"session/1",sessionsToken:"oma_sbx_test-only"})).toMatchObject({type:"failed",code:"token_rejected"});
});
it("refuses Work credentials before dispatch",async()=>{
  let calls=0;const resolve=createExecutionChannelsHttpResolver({apiBaseUrl:"https://control.test",fetch:async()=>{calls++;throw new Error("must not dispatch");}});
  await expect(resolve({tenantId:"tenant",sessionId:"session",sessionsToken:"work-only"})).rejects.toThrow("Work bearer");expect(calls).toBe(0);
});
it.each(["transport", "json", "failed"])("does not expose untrusted %s diagnostics", async kind => {
  const secret = "secret-sentinel-no-wire";
  const resolve = createExecutionChannelsHttpResolver({apiBaseUrl:"https://control.test",fetch:async()=>{
    if (kind === "transport") throw new Error(secret);
    if (kind === "json") return new Response(secret);
    return Response.json({type:"failed",phase:"token_validation",code:"token_rejected",message:secret});
  }});
  let diagnostic: string;
  try {
    const result = await resolve({tenantId:"tenant",sessionId:"session",sessionsToken:"oma_sbx_test-only"});
    expect(result.type).toBe("failed");
    diagnostic = result.type === "failed" ? result.message : "";
  } catch (error) { diagnostic = String(error); }
  expect(diagnostic).not.toContain(secret);
  expect(diagnostic).toContain("Execution channels");
});

it.each(["http", "malformed"])("never downgrades %s failure to Work channels", async kind=>{
  const resolve=createExecutionChannelsHttpResolver({apiBaseUrl:"https://control.test",fetch:async()=>kind==="http"?new Response(null,{status:503}):Response.json({mcpProxy:{sessionsToken:"oma_sbx_test-only"}})});
  await expect(resolve({tenantId:"tenant",sessionId:"session",sessionsToken:"oma_sbx_test-only"})).rejects.toThrow();
});


it("never follows a same-origin 307 with sandbox credentials or POST body", async () => {
  let recipients=0;
  const server=createServer((request,response)=>{
    if(request.url==="/unexpected-credential-recipient") {recipients++;response.writeHead(200,{"content-type":"application/json"});response.end("{}");}
    else {response.writeHead(307,{location:"/unexpected-credential-recipient"});response.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
    const resolve=createExecutionChannelsHttpResolver({apiBaseUrl:base});
    await expect(resolve({tenantId:"tenant",sessionId:"session",sessionsToken:"oma_sbx_test-only"})).rejects.toThrow();
    expect(recipients).toBe(0);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it("rejects an authority response replacing the bootstrap holder token", async () => {
  const resolve=createExecutionChannelsHttpResolver({apiBaseUrl:"https://control.test",fetch:async()=>Response.json({type:"ready",channels:{mcpProxy:{sessionsToken:"oma_sbx_other",gatewayBaseUrl:"https://control.test"},hostedInference:{sessionsToken:"oma_sbx_other",gatewayBaseUrl:"https://control.test",model:{providerId:"anthropic",baseUrl:null}}}})});
  await expect(resolve({tenantId:"tenant",sessionId:"session",sessionsToken:"oma_sbx_bootstrap"})).rejects.toThrow();
});
it("retains only typed model-unavailable evidence from a 409, never its message",async()=>{
 const resolve=createExecutionChannelsHttpResolver({apiBaseUrl:"https://control.test",fetch:async()=>Response.json({type:"failed",phase:"model_lookup",code:"model_unavailable",message:"secret-model-key",cause:{name:"secret"}},{status:409})});
 const result=await resolve({tenantId:"tenant",sessionId:"s",sessionsToken:"oma_sbx_holder"});
 expect(result).toMatchObject({type:"failed",phase:"model_lookup",code:"model_unavailable"});expect(JSON.stringify(result)).not.toContain("secret");
});
it("does not relabel a 403 as configuration evidence even with a forged known code",async()=>{
 const resolve=createExecutionChannelsHttpResolver({apiBaseUrl:"https://control.test",fetch:async()=>Response.json({type:"failed",phase:"model_lookup",code:"model_unavailable",message:"secret"},{status:403})});
 await expect(resolve({tenantId:"t",sessionId:"s",sessionsToken:"oma_sbx_holder"})).rejects.toThrow("HTTP 403");
});
