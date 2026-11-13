import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

/** Controlled model shared by actual Node HTTP and Workerd SSE route tests. */
export function earlyCustomModel(ordinaryName = "bash") {
  let history: unknown;
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("approve", { ticket: "first" }, { id: "early-first" }),
      fauxToolCall(ordinaryName, { command: "controlled side effect" }, { id: "ordinary" }),
      fauxToolCall("approve", { ticket: "last" }, { id: "early-last" }),
    ], { stopReason: "toolUse" }),
    context => { history = context.messages; return fauxAssistantMessage("done after both answers"); },
  ]);
  const models = createModels(); models.setProvider(faux.provider);
  return { faux, models, history: () => history };
}
