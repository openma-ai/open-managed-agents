import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
export function providerFailureModel(mixed = false) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  let observed = "";
  faux.setResponses([
    fauxAssistantMessage([...(mixed ? [fauxToolCall("approve_ticket",{ticket:"c1"},{id:"c1"})] : []),fauxToolCall("read", { file_path: "/failure-probe" }, { id: "failed-read" }),...(mixed ? [fauxToolCall("approve_ticket",{ticket:"c2"},{id:"c2"})] : [])], { stopReason: "toolUse" }),
    context => {
      observed = JSON.stringify(context.messages);
      return fauxAssistantMessage([fauxToolCall("write", { file_path: "/continued-action", content: "continued bytes" }, { id: "continued-write" })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("normal completion after error"),
  ]);
  const models = createModels(); models.setProvider(faux.provider);
  return { faux, models, observed: () => observed };
}

export function mixedPlatformModel(calls: Array<{id:string;name:string;args:Record<string,unknown>}>, secondRound = false) {
  const faux=fauxProvider({tokensPerSecond:100_000});
  const observed:unknown[]=[];
  faux.setResponses([
    fauxAssistantMessage(calls.map(call=>fauxToolCall(call.name,call.args,{id:call.id})),{stopReason:"toolUse"}),
    context=>{observed.push(structuredClone(context.messages));return fauxAssistantMessage("mixed complete");},
    ...(secondRound ? [
      fauxAssistantMessage(calls.map(call=>fauxToolCall(call.name,call.args,{id:call.id+"_r2"})),{stopReason:"toolUse"}),
      (context: {messages:unknown[]})=>{observed.push(structuredClone(context.messages));return fauxAssistantMessage("second round complete");},
    ] : []),
  ]);
  const models=createModels();models.setProvider(faux.provider);
  return {faux,models,observed};
}

export function sdkPostDispatchModel(first: string, recovery: string) {
  const faux=fauxProvider({tokensPerSecond:100_000});const observed:any[]=[];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash",{command:first},{id:"original"})],{stopReason:"toolUse"}),
    ctx=>{observed.push(...structuredClone(ctx.messages));return fauxAssistantMessage([fauxToolCall("bash",{command:recovery},{id:"recovery"})],{stopReason:"toolUse"});},
    fauxAssistantMessage("normal completion"),
  ]);
  const models=createModels();models.setProvider(faux.provider);
  return {faux,models,observed};
}
