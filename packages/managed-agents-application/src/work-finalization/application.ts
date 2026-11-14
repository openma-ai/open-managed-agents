import type {
  WorkFinalizationPersistencePort, WorkFinalizationHostPort, WorkTurnRequest,
  WorkTurnRevision, WorkTerminalStopReason, WorkTurnState, WorkTerminalReceipt,
  WorkFinalizationRejection, WorkFinalizationScope,
} from "./ports";

export type WorkFinalizationResult = WorkFinalizationRejection
  | {type:"run"|"prepared";turnId:string;revision:number}
  | {type:"committed"|"parked"|"published";revision:number;terminal:WorkTerminalReceipt}
  | {type:"unavailable";phase:"finalization"}
  | {type:"failed";phase:"run"|"finalization";terminal?:WorkTerminalReceipt};
const rejected = (reason:string):WorkFinalizationRejection => ({type:"rejected",reason});
function terminalResult(state:Extract<WorkTurnState,{type:"current"}>):WorkFinalizationResult {
  const terminal=state.terminal!;
  return {type:terminal.stopReason.type === "requires_action" || terminal.stopReason.type === "budget_reached" ? "parked" : "committed", revision:state.revision,terminal};
}

export class WorkFinalizationApplication {
  constructor(private readonly dependencies:{persistence:WorkFinalizationPersistencePort;host?:WorkFinalizationHostPort;now?:()=>Date}) {}

  async recover(input:WorkTurnRequest):Promise<WorkFinalizationResult> {
    const state=await this.dependencies.persistence.inspect(input);
    if(state.type!=="current")return state;
    if(state.terminal)return terminalResult(state);
    // A consumed input alone cannot prove ACP acceptance or side-effect-free
    // failure. Never turn response loss into automatic model redispatch.
    return state.consumed ? {type:"gap",reason:"consumed_turn_without_terminal",revision:state.revision}
      : {type:"run",turnId:input.turnId,revision:state.revision};
  }

  private scope(input:WorkTurnRevision,terminalEventId?:string,allowRevisionAdvance=false):WorkFinalizationScope {
    return {...input,isCurrent:async()=>{
      const state=await this.dependencies.persistence.inspect(input);
      if(state.type!=="current") return false;
      const revisionOk=allowRevisionAdvance ? state.revision>=input.revision : state.revision===input.revision;
      return revisionOk &&
        (terminalEventId===undefined ? state.terminal===null && state.consumed : state.terminal?.eventId===terminalEventId);
    }};
  }

  async checkpoint(input:WorkTurnRevision):Promise<WorkFinalizationResult> {
    const state=await this.dependencies.persistence.inspect(input);
    if(state.type!=="current")return state;
    if(state.terminal)return terminalResult(state);
    if(state.revision!==input.revision || !state.consumed)return rejected("turn_revision");
    if(!this.dependencies.host)return {type:"unavailable",phase:"finalization"};
    // Physical persistence can take long enough for the same turn to append
    // its final canonical facts. Rebase the checkpoint to that newer
    // revision; SqlWorkFinalization still rejects a successor consumed by a
    // different turn, so this does not widen authority across turns.
    const scope=this.scope(input,undefined,true);
    try {
      const result=await this.dependencies.host.prepare(scope);
      const after=await this.dependencies.persistence.inspect(input);
      if(after.type!=="current" || after.revision<state.revision || after.terminal!==null || !after.consumed) {
        console.warn(JSON.stringify({op:"work.finalization.checkpoint_authority_changed",session_id:input.claim.sessionId,work_id:input.claim.workId,generation:input.claim.generation,turn_id:input.turnId,initial_revision:state.revision,after_type:after.type,after_revision:after.type==="current"?after.revision:undefined,after_reason:after.type!=="current"&&"reason" in after?after.reason:undefined}));
        return rejected("authority_changed");
      }
      return result.type==="prepared" ? {type:"prepared",turnId:input.turnId,revision:after.revision}
        : {type:"unavailable",phase:"finalization"};
    } catch {
      if(!await scope.isCurrent())return rejected("authority_changed");
      return {type:"failed",phase:"finalization"};
    }
  }

  async finalize(input:WorkTurnRevision & {stopReason:WorkTerminalStopReason}):Promise<WorkFinalizationResult> {
    const state=await this.dependencies.persistence.inspect(input);
    if(state.type!=="current")return state;
    if(state.terminal)return terminalResult(state);
    if(state.revision!==input.revision || !state.consumed)return rejected("turn_revision");
    if(!this.dependencies.host)return {type:"unavailable",phase:"finalization"};
    try {
      const prepared=await this.dependencies.host.prepare(this.scope(input));
      if(prepared.type!=="prepared")return {type:"unavailable",phase:"finalization"};
    } catch {
      const failed=await this.fail({...input,phase:"finalization"});
      return failed.type==="committed" ? {type:"failed",phase:"finalization",terminal:failed.terminal} : failed;
    }
    // Host completion does not confer authority; commit repeats canonical turn,
    // holder, generation, live lease and Session revision checks atomically.
    const committed=await this.dependencies.persistence.commit({...input,processedAt:(this.dependencies.now?.()??new Date()).toISOString()});
    return committed.type==="current" && committed.terminal ? terminalResult(committed)
      : committed.type==="current" ? rejected("terminal_missing") : committed;
  }

  async fail(input:WorkTurnRevision & {phase:"run"|"finalization"}):Promise<WorkFinalizationResult> {
    const state=await this.dependencies.persistence.inspect(input);
    if(state.type!=="current")return state;
    if(state.terminal)return terminalResult(state); // never rewrite committed success
    if(state.revision!==input.revision || !state.consumed)return rejected("turn_revision");
    const committed=await this.dependencies.persistence.commit({...input,stopReason:{type:"retries_exhausted"},failure:input.phase,
      processedAt:(this.dependencies.now?.()??new Date()).toISOString()});
    return committed.type==="current" && committed.terminal ? terminalResult(committed)
      : committed.type==="current" ? rejected("terminal_missing") : committed;
  }

  async publish(input:WorkTurnRevision & {terminalEventId:string}):Promise<WorkFinalizationResult> {
    const state=await this.dependencies.persistence.inspect(input);
    if(state.type!=="current")return state;
    if(state.revision!==input.revision || state.terminal?.eventId!==input.terminalEventId)return rejected("terminal_revision");
    if(!this.dependencies.host)return {type:"unavailable",phase:"finalization"};
    // Terminal persistence is immutable for this turn, but lifecycle and
    // usage events may be appended while physical artifacts are published.
    // Keep the terminal event/claim fence exact while accepting a monotonic
    // revision advance from that same turn.
    const scope=this.scope(input,input.terminalEventId,true);
    try {
      const result=await this.dependencies.host.publish({...scope,terminal:state.terminal});
      if(!await scope.isCurrent())return rejected("authority_changed");
      return result.type==="published" ? {type:"published",revision:state.revision,terminal:state.terminal}
        : {type:"unavailable",phase:"finalization"};
    } catch {
      if(!await scope.isCurrent())return rejected("authority_changed");
      return {type:"failed",phase:"finalization",terminal:state.terminal};
    }
  }
}
