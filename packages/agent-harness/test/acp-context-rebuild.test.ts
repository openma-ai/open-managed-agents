import { beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { rebuildAcpContext } from "../src/acp-recovery";
import type { HarnessContext } from "../src/interface";
import { harnessContextFromEvents, transitionHarnessContext } from "@open-managed-agents/session-runtime-contract";
const completeSimple = vi.hoisted(() => vi.fn());
beforeEach(() => completeSimple.mockReset());
function context(history: unknown[]): HarnessContext {
  return {
    acpRecoveryHistory: history,
    userMessage: {type:"user.message",content:[{type:"text",text:"recall"}]},
    model:{},
    pi: {
      models: { completeSimple } as never,
      model: { id: "recovery-model", api: "faux", provider: "faux", contextWindow: 128_000, maxTokens: 2_000 } as never,
      speed: "standard",
    },
    systemPrompt:"",
    tools:{},
    runtime:{history:{getEvents:()=>history},broadcast:(event:unknown)=>history.push(event)} as never,
  } as unknown as HarnessContext;
}
describe("explicit ACP context recovery", () => {
  it("projects the durable native id and fingerprint outside the sandbox", () => {
    const state = transitionHarnessContext({state:"none"},{type:"record_native",id:"native-1",fingerprint:"sha-1"});
    expect(harnessContextFromEvents([{type:"session.warning",source:"oma.acp_context",details:{...state}}])).toEqual(state);
    expect(transitionHarnessContext(state,{type:"rebuild",id:"native-2",fingerprint:"sha-2",reason:"checkpoint-unavailable"})).toEqual({state:"rebuilt",from:"canonical_history",acp_session_id:"native-2",checkpoint_fingerprint:"sha-2",reason:"checkpoint-unavailable"});
  });
  it("compacts over-limit canonical history without silently dropping the earliest passphrase", async () => {
    const history = [{type:"user.message",content:[{type:"text",text:"passphrase amber-otter"}]}, ...Array.from({length:4},()=>({type:"agent.message",content:[{type:"text",text:"x".repeat(10000)}]}))];
    completeSimple.mockImplementationOnce(async (_model: unknown, request: unknown) => { expect(JSON.stringify(request)).toContain("passphrase amber-otter"); return fauxAssistantMessage("passphrase amber-otter"); });
    const result = await rebuildAcpContext(context(history),"checkpoint-unavailable");
    expect(result).toMatchObject({compacted:true,exceedsLimit:true});
    expect(result.prompt).toContain("passphrase amber-otter");
    expect(history).toContainEqual(expect.objectContaining({type:"agent.thread_context_compacted"}));
  });
  it("retains all usable history if compaction fails, explicitly reports the limit", async () => {
    const history=[{type:"user.message",content:[{type:"text",text:"earliest-passphrase "+"x".repeat(40000)}]}];
    completeSimple.mockRejectedValueOnce(new Error("summary unavailable"));
    const result=await rebuildAcpContext(context(history),"execution-lost");
    expect(result).toMatchObject({compacted:false,exceedsLimit:true});
    expect(result.prompt).toContain("earliest-passphrase "+"x".repeat(40000));
  });
  it("does not count the current request itself as recovered history", async () => {
    const ctx = context([]);
    ctx.acpRecoveryHistory = [ctx.userMessage];
    await expect(rebuildAcpContext(ctx,"checkpoint-unavailable")).rejects.toThrow("no usable conversation");
  });
  it("errors instead of inventing blank context when no usable history remains", async () => {
    await expect(rebuildAcpContext(context([]),"checkpoint-unavailable")).rejects.toThrow("no usable conversation");
  });
});
