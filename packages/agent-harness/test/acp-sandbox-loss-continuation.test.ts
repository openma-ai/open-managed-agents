import { expect, it } from "vitest";
import { AcpSandboxHarness } from "../src/acp-sandbox-loop";
import type { HarnessContext } from "../src/interface";

// Real ACP client/placement/translator, a bounded JSON-RPC process peer.
// This is protocol-boundary coverage, not a provider certification.
it.each(["prompt", "transport", "dispose"])("sandbox loss at %s stays outside Session ownership", async boundary => {
  const events: any[] = [], prompts: string[] = [];
  let launches = 0;
  const files = new Map<string, string>();
  const port = {
    exec: async () => "", resolveWorkspaceRoot: async () => "/workspace",
    readFile: async (p: string) => { if (!files.has(p)) throw new Error("missing"); return files.get(p)!; },
    writeFile: async (p: string, value: string) => { files.set(p, value); return "ok"; },
    async spawnDuplexProcess() {
      const attempt = ++launches;
      let output!: ReadableStreamDefaultController<Uint8Array>;
      let errors!: ReadableStreamDefaultController<Uint8Array>;
      let exit!: (value: any) => void;
      let gone = false, closed = false, buffer = "";
      const exited = new Promise<any>(r => { exit = r; });
      const send = (value: any) => output.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
      const close = () => { if (closed) return; closed = true; output.close(); errors.close(); exit({code:137,signal:null}); };
      return {
        stdout: new ReadableStream<Uint8Array>({start(c) {output=c;}}),
        stderr: new ReadableStream<Uint8Array>({start(c) {errors=c;}}), exited,
        confirmSandboxGone: async () => gone,
        stdin: new WritableStream<Uint8Array>({write(bytes) {
          buffer += new TextDecoder().decode(bytes);
          let i: number;
          while ((i=buffer.indexOf("\n")) >= 0) {
            const request=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1);
            const reply=(result:any)=>send({jsonrpc:"2.0",id:request.id,result});
            const update=(update:any)=>send({jsonrpc:"2.0",method:"session/update",params:{sessionId:`native-${attempt}`,update}});
            if(request.method==="initialize") reply({protocolVersion:1,agentCapabilities:{}});
            else if(request.method==="session/new") reply({sessionId:`native-${attempt}`});
            else if(request.method==="session/prompt") {
              prompts.push(JSON.stringify(request.params.prompt));
              if(attempt===1 && (boundary==="prompt" || boundary==="transport")) {
                update({sessionUpdate:"tool_call",toolCallId:"failed-job",title:"read",kind:"read",status:"in_progress",rawInput:{path:"/probe"}});
                // Deliver the call before the independent provider reports loss.
                setTimeout(()=>{gone=boundary==="prompt";close();},10);
              } else {
                update({sessionUpdate:"tool_call",toolCallId:"successful-job",title:"write",kind:"edit",status:"in_progress",rawInput:{path:"/continued"}});
                files.set("/continued","continued after loss");
                update({sessionUpdate:"tool_call_update",toolCallId:"successful-job",status:"completed",rawOutput:"written"});
                update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"done"}});
                reply({stopReason:"end_turn"});
              }
            } else if(request.id!==undefined) send({jsonrpc:"2.0",id:request.id,error:{code:-32601,message:"unsupported"}});
          }
        }}),
        async kill() { if(boundary==="dispose") gone=true; close(); },
      };
    },
  };
  const runtime:any={sandbox:port,history:{getEvents:()=>events},broadcast:(e:any)=>events.push(e),
    broadcastStreamStart:async()=>{},broadcastChunk:async()=>{},broadcastStreamEnd:async()=>{},
    broadcastThinkingStart:async()=>{},broadcastThinkingChunk:async()=>{},broadcastThinkingEnd:async()=>{},
    abortSignal:new AbortController().signal};
  const ctx={agent:{model:"test",acp:{agent:{command:"protocol-peer"}}},session_id:"loss-protocol",systemPrompt:"",env:{},tools:{},runtime,
    userMessage:{type:"user.message",content:[{type:"text",text:"finish the task"}]}} as unknown as HarnessContext;
  const harness=new AcpSandboxHarness();
  await expect(harness.run(ctx)).resolves.toBeUndefined();
  console.log(JSON.stringify({boundary,launches,prompts,events}));
  expect(files.get("/continued")).toBe("continued after loss");
  expect(events.filter(e=>e.type==="session.error")).toEqual([]);
  expect(events.filter(e=>e.type.startsWith("session.status"))).toEqual([]);
  expect(events.filter(e=>e.type==="agent.tool_result" && !e.is_error)).toHaveLength(1);
  if((boundary==="prompt" || boundary==="transport")) {
    const failed=events.filter(e=>e.type==="agent.tool_result"&&e.is_error);
    expect(failed).toHaveLength(1);
    const call=events.find(e=>e.type==="agent.tool_use"&&e.name==="read");
    expect(failed[0].tool_use_id).toBe(call.id);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Failed tool read");
    expect(prompts[1]).toContain("Do not repeat completed side effects");
  } else expect(prompts).toHaveLength(1);
  await harness.dispose("shutdown");
}, 15_000);
