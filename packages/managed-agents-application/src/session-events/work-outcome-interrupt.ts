import type { SentSessionEvent } from "../domain/session-event";

/** Server-owned consequence of a durable interrupt. No worker-supplied result,
 * root, generation or span id is accepted at this boundary. */
export interface WorkOutcomeInterruptPort {
  settle(input:{workspaceId:string;sessionId:string;interruptId:string}):Promise<void>;
}
export async function settleAcceptedWorkOutcomeInterrupts(port:WorkOutcomeInterruptPort|undefined,input:{workspaceId:string;sessionId:string;events:readonly SentSessionEvent[]}):Promise<void>{
  if(!port)return;
  for(const event of input.events)if(event.type==="user.interrupt" && event.environmentWorkId!=null)
    await port.settle({workspaceId:input.workspaceId,sessionId:input.sessionId,interruptId:event.id});
}
