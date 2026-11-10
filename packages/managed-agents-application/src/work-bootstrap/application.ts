import type { WorkFinalizationClaim, WorkFinalizationPersistencePort } from "../work-finalization/ports";
import { planWorkBootstrap } from "./planner";
import type { WorkBootstrapPersistencePort, WorkBootstrapResult } from "./ports";
export class WorkBootstrapApplication {
 constructor(private readonly dependencies:{persistence:WorkBootstrapPersistencePort;finalization:Pick<WorkFinalizationPersistencePort,"inspect">}){}
 async read(claim:WorkFinalizationClaim):Promise<WorkBootstrapResult>{
  const snapshot=await this.dependencies.persistence.read(claim);
  if(snapshot.type!=="snapshot")return snapshot;
  const {revision}=snapshot;
  const candidate=planWorkBootstrap({...snapshot,claim});
  let result:WorkBootstrapResult;
  if(candidate.type==="gap"||candidate.type==="rejected")result={...candidate,revision};
  else if(candidate.type==="idle")result={...candidate,claim,revision};
  else {
   const state=await this.dependencies.finalization.inspect({claim,turnId:candidate.root.turnId});
   if(state.type!=="current")result={type:state.type==="rejected"?"gap":state.type,reason:state.type==="rejected"?`finalization_${state.reason}`:state.reason,root:candidate.root,revision};
   else if(state.revision!==revision)result={type:"rejected",reason:"authority_changed"};
   else if(candidate.type==="run"?(state.consumed||state.terminal!==null):state.terminal?.eventId!==candidate.terminal.eventId)result={type:"rejected",reason:"plan_changed"};
   else result={...candidate,claim,revision};
  }
  if(!await this.dependencies.persistence.isCurrent(claim,revision,snapshot.workState))return {type:"rejected",reason:"authority_changed"};
  if(snapshot.workState==="stopping"&&(result.type==="run"||result.type==="idle"))return {type:"rejected",reason:"work_stopping"};
  return result;
 }
}
