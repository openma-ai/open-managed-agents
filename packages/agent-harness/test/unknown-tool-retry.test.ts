import { expect, it } from "vitest";
import type { HarnessRuntime } from "../src/interface";
import { parkUnknownToolRetry, requestUnknownToolRetry } from "../src/unknown-tool-retry";
import { AcpProxyHarness } from "../src/acp-proxy-loop";
import type { HarnessContext } from "../src/interface";

it("does not let another lane's last event unpark the primary unknown", () => {
  const events = [
    {id:"effect",type:"agent.tool_use",name:"bash",input:{command:"effect"}},
    {type:"session.warning",source:"tool_outcome_unknown",details:{outcome:"dispatched_unknown",tool_use_id:"effect",retry_request_id:"retry:effect"}},
    {id:"retry:effect",type:"agent.tool_use",name:"bash",input:{command:"effect"}},
    {type:"user.message",session_thread_id:"other",content:[]},
  ];
  const runtime={history:{getEvents:()=>events},broadcast:(event:unknown)=>events.push(event as never)} as unknown as HarnessRuntime;
  expect(parkUnknownToolRetry(runtime)).toBe(true);
  expect(runtime.pendingConfirmations).toEqual(["retry:effect"]);
});
it("does not connect a native proxy while an unknown retry waits for authorization", async () => {
  const events = [
    {id:"effect",type:"agent.tool_use",name:"bash",input:{command:"effect"}},
    {type:"session.warning",source:"tool_outcome_unknown",details:{outcome:"dispatched_unknown",tool_use_id:"effect",retry_request_id:"retry:effect"}},
    {id:"retry:effect",type:"agent.tool_use",name:"bash",input:{command:"effect"}},
  ];
  let connects=0;
  const runtime={history:{getEvents:()=>events},broadcast:(event:unknown)=>events.push(event as never)} as unknown as HarnessRuntime;
  const ctx={runtime,agent:{runtime_binding:{runtime_id:"native"}},session_id:"session",runnerRelay:{attachHarness:async()=>{connects++;return {type:"refused",status:404};}},userMessage:{type:"user.message",content:[{type:"text",text:"continue"}]}} as unknown as HarnessContext;
  await new AcpProxyHarness().run(ctx);
  expect(connects).toBe(0);
  expect(runtime.pendingConfirmations).toEqual(["retry:effect"]);
});
it("does not copy the original event timestamp onto a new retry authorization", () => {
  const events=[{id:"effect",type:"agent.tool_use",name:"bash",input:{command:"effect"},processed_at:"2026-01-01T00:00:00Z"}];
  const runtime={history:{getEvents:()=>events},broadcast:(event:unknown)=>events.push(event as never)} as unknown as HarnessRuntime;
  requestUnknownToolRetry(runtime,"effect");
  expect(events.find(event=>event.id==="retry:effect")).not.toHaveProperty("processed_at");
});
it("freezes retry input independently of the original input object", () => {
  const input={command:"effect",nested:{value:1}};
  const events=[{id:"effect",type:"agent.tool_use",name:"bash",input}];
  const runtime={history:{getEvents:()=>events},broadcast:(event:unknown)=>events.push(event as never)} as unknown as HarnessRuntime;
  requestUnknownToolRetry(runtime,"effect");
  input.command="different";input.nested.value=2;
  expect(events).toContainEqual(expect.objectContaining({id:"retry:effect",input:{command:"effect",nested:{value:1}}}));
});
it("does not resurrect an interrupted retry request after restart", () => {
  const events=[{id:"effect",type:"agent.tool_use",name:"bash",input:{command:"effect"}},
    {type:"session.warning",source:"tool_outcome_unknown",details:{outcome:"dispatched_unknown",tool_use_id:"effect",retry_request_id:"retry:effect"}},
    {id:"retry:effect",type:"agent.tool_use",name:"bash",input:{command:"effect"}}, {type:"user.interrupt"}];
  const runtime={history:{getEvents:()=>events},broadcast:(event:unknown)=>events.push(event as never)} as unknown as HarnessRuntime;
  expect(parkUnknownToolRetry(runtime)).toBe(true);
  expect(runtime.pendingConfirmations).toBeUndefined();
});
it("repairs a missing frozen retry request before parking", () => {
  const events = [
    {id:"effect",type:"agent.tool_use",name:"bash",input:{command:"effect"}},
    {type:"session.warning",source:"tool_outcome_unknown",details:{outcome:"dispatched_unknown",tool_use_id:"effect",retry_request_id:"retry:effect"}},
  ];
  const runtime={history:{getEvents:()=>events},broadcast:(event:unknown)=>events.push(event as never)} as unknown as HarnessRuntime;
  expect(parkUnknownToolRetry(runtime)).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({id:"retry:effect",type:"agent.tool_use",input:{command:"effect"}}));
});

it("does not treat an unconsumed allow as a terminal retry", () => {
  const events=[{id:"o",type:"agent.tool_use",name:"bash",input:{command:"effect"}},
    {type:"session.warning",source:"tool_outcome_unknown",details:{outcome:"dispatched_unknown",tool_use_id:"o",retry_request_id:"retry:o"}},
    {id:"retry:o",type:"agent.tool_use",name:"bash",input:{command:"effect"}},
    {type:"user.tool_confirmation",tool_use_id:"retry:o",result:"allow"}];
  const runtime={history:{getEvents:()=>events},broadcast:()=>{}} as unknown as HarnessRuntime;
  expect(parkUnknownToolRetry(runtime)).toBe(true);
});
