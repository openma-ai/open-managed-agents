import type { DirectoryBackupRecord } from "@cloudflare/sandbox";
import type { WorkFinalizationClaim } from "@open-managed-agents/managed-agents-application";

/** Trusted DO process metadata, not a container-authored locator. No bearer is persisted. */
export interface NativeWorkProcess extends WorkFinalizationClaim {
  id: string;
  epoch: string;
  pid: number;
  startTicks: string;
  holderHash: string;
  status: "starting" | "running" | "exited";
  mounts: Array<{ mountPath: string; keyPrefix: string; access: "read-only" | "read-write" }>;
}
export interface NativeWorkCheckpoint {
  allocationId: string;
  backup: DirectoryBackupRecord;
}
export type NativeWorkIO =
  | { type: "run"; command: string }
  | { type: "read" | "readBytes"; path: string }
  | { type: "write"; path: string; content: string; encoding?: "base64" };
export function sameNativeWorkProcess(a: NativeWorkProcess, b: NativeWorkProcess): boolean {
  return (["workspaceId", "environmentId", "sessionId", "workId", "generation", "holder", "holderHash", "id", "epoch", "pid", "startTicks"] as const).every(k => a[k] === b[k]);
}
