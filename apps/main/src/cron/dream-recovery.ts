import {
  log,
  logError,
  type Env,
} from "@open-managed-agents/shared";
import { forEachShardServices } from "@open-managed-agents/services";
import { pickCurator, runDream } from "@open-managed-agents/dreams-pipeline";

// Wall-clock window after which a `running` dream is considered orphaned.
// 5 minutes is a deliberate trade-off:
//   - longer than the typical dedup curator pass (sub-second) so we don't
//     pick up dreams that are just slow to commit
//   - shorter than the spec-quoted "minutes to tens of minutes" upper bound
//     so user-facing latency on a stuck dream tops out around 5 + tick
// Tune via env if a deployment runs heavy LLM curations that exceed this.
const STALENESS_MS = 5 * 60 * 1000;

/**
 * Recovery sweep for the dreams pipeline. Re-kicks any dream that's been in
 * `running` longer than the staleness window — the in-process driver
 * (packages/dreams-pipeline/src/dream-runner.ts) has no checkpoint, so if the
 * Worker dies mid-curation we need a way to nudge the dream forward.
 *
 * Idempotency: the runner's steps are safe to re-execute (provision creates
 * an output store only while the dream is pending; recovery of a running
 * dream reuses the already-published output store, writes upsert-by-path,
 * and markCompleted refreshes terminal state if it races with cancel).
 *
 * Wired into the every-minute cron in apps/main/src/index.ts. The sweep
 * fans out across shards via `forEachShardServices`; each shard's stuck
 * dreams are re-kicked in parallel within the shard.
 */
export async function dreamRecoveryTick(env: Env): Promise<void> {
  const curator = pickCurator(env);
  try {
    const perShard = await forEachShardServices(env, async (services, shardName) => {
      try {
        const stuck = await services.dreams.findStuckRunning({
          staleAfterMs: STALENESS_MS,
        });
        if (stuck.length === 0) return 0;
        log(
          { op: "cron.dream_recovery.shard", shard: shardName, count: stuck.length },
          `re-kicking ${stuck.length} stuck dream(s) on ${shardName}`,
        );
        await Promise.all(
          stuck.map((dream) =>
            runDream({
              services,
              curator,
              tenantId: dream.tenant_id,
              dreamId: dream.id,
            }).catch((err) => {
              logError(
                { op: "cron.dream_recovery.run", shard: shardName, dream_id: dream.id, err },
                `runDream failed during recovery`,
              );
            }),
          ),
        );
        return stuck.length;
      } catch (err) {
        logError(
          { op: "cron.dream_recovery.shard", shard: shardName, err },
          `dream recovery sweep failed on ${shardName}`,
        );
        return 0;
      }
    });
    const total = perShard.reduce((a, b) => a + b, 0);
    if (total > 0) {
      log(
        { op: "cron.dream_recovery", total },
        `dream recovery sweep complete: ${total} dream(s) re-kicked across all shards`,
      );
    }
  } catch (err) {
    logError({ op: "cron.dream_recovery", err }, "dream recovery fan-out failed");
  }
}
