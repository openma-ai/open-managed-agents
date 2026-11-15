import type { WorkFinalizationClaim, WorkTerminalReceipt } from "../work-finalization/ports";
import type { CanonicalWorkTurnRow } from "../work-finalization/turn-plan";
export interface WorkBootstrapRoot { inputId:string; turnId:string; position:{revision:number;index:number} }
export type WorkBootstrapCandidate =
 | {type:"run";root:WorkBootstrapRoot}
 | {type:"cleanup-only"|"parked";root:WorkBootstrapRoot;terminal:WorkTerminalReceipt}
 | {type:"idle";root:null}
 | {type:"gap";reason:string;root?:WorkBootstrapRoot}
 | {type:"rejected";reason:string;root?:WorkBootstrapRoot};
export interface WorkBootstrapSnapshot {
 type:"snapshot"; workState?:string; revision:number; rows:CanonicalWorkTurnRow[]; budgetExhausted:boolean;
}
export type WorkBootstrapResult =
 | (Extract<WorkBootstrapCandidate,{type:"run"|"cleanup-only"|"parked"|"idle"}> & {claim:WorkFinalizationClaim;revision:number})
 | {type:"gap"|"rejected";reason:string;root?:WorkBootstrapRoot;revision?:number};
export interface WorkBootstrapPersistencePort {
 read(claim:WorkFinalizationClaim):Promise<WorkBootstrapSnapshot|{type:"rejected"|"gap";reason:string}>;
 /** Revalidate live claim, TTL, state AND captured Session revision after all reads. */
 isCurrent(claim:WorkFinalizationClaim,revision:number,workState?:string):Promise<boolean>;
}
