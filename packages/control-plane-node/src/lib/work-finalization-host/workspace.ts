import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { NodeWorkStorageInput } from "../node-session-sandbox.js";
import type { NodeManagedWorkspaceCheckpoints } from "../node-managed-workspace-checkpoints.js";

/** One transfer mapping for strict Work archive AND restore. */
export function workCheckpointExecutor(sandbox: SandboxExecutor): SandboxExecutor {
  const transfer = (path: string) => path.replaceAll("/var/tmp/openma-workspace-", "/oma/checkpoint-transfer/openma-workspace-");
  return {
    exec: (command, timeout) => sandbox.exec(`mkdir -p /oma/checkpoint-transfer && ${transfer(command).replace("tar -C ", "tar --exclude=./.mnt/oma/checkpoint-transfer -C ")}`, timeout),
    readFile: path => sandbox.readFile(transfer(path)),
    writeFile: (path, text) => sandbox.writeFile(transfer(path), text),
    readFileBytes: sandbox.readFileBytes ? path => sandbox.readFileBytes!(transfer(path)) : undefined,
    writeFileBytes: sandbox.writeFileBytes ? (path, bytes) => sandbox.writeFileBytes!(transfer(path), bytes) : undefined,
    resolveWorkspaceRoot: sandbox.resolveWorkspaceRoot ? () => sandbox.resolveWorkspaceRoot!() : undefined,
  };
}

/** Called only before launching a NEW physical runtime, never on exact attach. */
export async function restoreWorkCheckpoint(checkpoints: NodeManagedWorkspaceCheckpoints, physical: NodeWorkStorageInput, lease: {ownerId: string; expiresAt: string}) {
  const {attempt,holderHash,isCurrent} = physical.workAuthority;
  if (!holderHash || !await isCurrent()) throw new Error("Work checkpoint restore authority lost");
  const scope = {workspaceId:physical.workspaceId,environmentId:physical.environment.id,sessionId:physical.session.id,workId:attempt.executionId};
  const active = await checkpoints.active(scope);
  if (!active) return;
  const fence = {...scope,ownerId:lease.ownerId,generation:attempt.generation,token:holderHash,expiresAt:lease.expiresAt};
  // Every mutating sandbox operation rechecks authority; failed extraction must
  // prevent process launch, not fall through to a fresh model session.
  const executor = workCheckpointExecutor(physical.sandbox);
  const check = async () => { if (!await isCurrent()) throw new Error("Work checkpoint restore authority lost"); };
  const port = checkpoints.port({...executor,
    exec:async(...args)=>{await check();const result=await executor.exec(...args);await check();return result;},
    writeFileBytes:executor.writeFileBytes ? async(...args)=>{await check();const result=await executor.writeFileBytes!(...args);await check();return result;} : undefined,
  });
  const signal = new AbortController().signal;
  const binding = await port.materialize({scope,fence,strategy:"checkpoint_restore",activeCheckpoint:active.candidate,idempotencyKey:attempt.attemptId,signal});
  try {
    await port.attach({scope,fence,strategy:"checkpoint_restore",binding,sandbox:{provider:"node",runtimeId:physical.runtimeGeneration},signal});
    await check();
  } finally { await port.release({scope,fence,binding}); }
}
