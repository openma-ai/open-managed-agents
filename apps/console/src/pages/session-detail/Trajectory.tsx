import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  rewardHeadline,
  outcomeToStatusTone,
  type Trajectory,
} from "../../lib/trajectory";
import { StatusPill } from "../../components/Badge";
import { Modal } from "../../components/Modal";
import { Button } from "@/components/ui/button";
import { TrajectoryInspector } from "../../components/trajectory/TrajectoryInspector";
import { useApi } from "../../lib/api";

/**
 * Session-detail trajectory views.
 *
 * Three pieces:
 *   - `TrajectoryOutcomeChip` — small "Outcome: X" pill rendered in the
 *     session header. Hidden while loading / on error / when the agent
 *     is still running.
 *   - `TrajectoryRewardChip` — paired pill showing the verifier's reward
 *     score. Tooltip reveals the verifier id + computed-at timestamp.
 *   - `TrajectoryViewerModal` — structured run inspector (see
 *     components/trajectory/TrajectoryInspector) plus Raw JSON + Download.
 *   - `useTrajectoryLoader` — on-demand envelope fetch used by SessionDetail.
 *
 * Lifted out of SessionDetail to keep the orchestrator focused on event
 * stream + chat scaffolding.
 */

export function TrajectoryOutcomeChip({
  trajectory,
}: {
  trajectory: TrajectoryState;
}) {
  if (!trajectory || trajectory === "loading" || trajectory === "error") return null;
  if (trajectory.outcome === "running") return null;
  const tone = outcomeToStatusTone(trajectory.outcome);
  return (
    <StatusPill
      status={tone}
      label={`Outcome: ${trajectory.outcome}`}
    />
  );
}

/** Reward chip rendered in the session header strip. Pure read-out of
 *  the verifier output; tooltip shows verifier_id for debugging. */
export function TrajectoryRewardChip({
  trajectory,
}: {
  trajectory: TrajectoryState;
}) {
  if (!trajectory || trajectory === "loading" || trajectory === "error") return null;
  const r = trajectory.reward;
  if (!r) return null;
  const headline = rewardHeadline(r);
  const isPass = r.final_reward >= 0.99;
  const isFail = r.final_reward <= 0;
  // Reuse StatusPill tone tokens so the visual language stays consistent
  // with the outcome chip next to it (success = same green, failure = red).
  const tone = isPass ? "completed" : isFail ? "errored" : "neutral";
  const titleParts = [
    `Reward: ${r.final_reward.toFixed(4)}`,
    r.verifier_id ? `verifier: ${r.verifier_id}` : null,
    r.computed_at ? `computed: ${new Date(r.computed_at).toLocaleString()}` : null,
  ].filter(Boolean) as string[];
  return (
    <span title={titleParts.join(" · ")}>
      <StatusPill status={tone} label={`Reward: ${headline}`} />
    </span>
  );
}

/** True when clicking the Trajectory button should (re)fetch the envelope:
 *  nothing loaded yet, the last attempt failed, or the run was still going
 *  when we fetched it. */
export function trajectoryNeedsFetch(trajectory: TrajectoryState): boolean {
  if (trajectory === undefined || trajectory === "error") return true;
  if (trajectory === "loading") return false;
  return trajectory.outcome === "running";
}

export type TrajectoryState = Trajectory | "loading" | "error" | undefined;

/**
 * On-demand loader for `GET /v1/oma/sessions/:id/trajectory` (OpenMA
 * product route, so plain `api()` rather than `managedApi`). State resets
 * whenever `sessionId` changes, and responses for a stale session id or a
 * superseded request are dropped.
 */
export function useTrajectoryLoader(sessionId: string | undefined) {
  const { api } = useApi();
  const [trajectory, setTrajectory] = useState<TrajectoryState>(undefined);
  const ticket = useRef(0);

  useEffect(() => {
    ticket.current += 1;
    setTrajectory(undefined);
  }, [sessionId]);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const mine = ++ticket.current;
    setTrajectory("loading");
    try {
      const t = await api<Trajectory>(`/v1/oma/sessions/${encodeURIComponent(sessionId)}/trajectory`);
      if (ticket.current === mine) setTrajectory(t);
    } catch {
      if (ticket.current === mine) setTrajectory("error");
    }
  }, [api, sessionId]);

  return { trajectory, load };
}

/** Download the envelope as `trajectory-<session>.json` via an in-memory
 *  blob URL, so there's no second round-trip to the server. */
export function downloadTrajectoryJson(sessionId: string, json: string) {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `trajectory-${sessionId}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Trajectory viewer modal: structured inspector (stats, turn strip,
 * conversation/execution split, paired tool steps, wall-clock timeline,
 * filters, copy-all) above a Raw JSON view with Download.
 *
 * The envelope drives outcome, reward, summary and the download. When it
 * is still loading (or failed) and `liveEvents` are supplied, a
 * provisional transcript renders from those so the modal isn't empty.
 */
export function TrajectoryViewerModal({
  open,
  onClose,
  sessionId,
  trajectory,
  liveEvents,
  onRetry,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  trajectory: TrajectoryState;
  liveEvents?: readonly unknown[];
  onRetry?: () => void;
}) {
  const ready = trajectory !== undefined && trajectory !== "loading" && trajectory !== "error";
  const json = useMemo(() => (ready ? JSON.stringify(trajectory, null, 2) : ""), [ready, trajectory]);
  const envelopeEvents = ready ? trajectory.events : undefined;
  const fallback = !ready && liveEvents && liveEvents.length > 0 ? liveEvents : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Trajectory"
      subtitle={ready ? `${trajectory.trajectory_id} · session ${sessionId}` : `session ${sessionId}`}
      maxWidth="max-w-6xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={() => ready && downloadTrajectoryJson(sessionId, json)} disabled={!ready}>
            Download JSON
          </Button>
        </>
      }
    >
      {trajectory === "loading" && (
        <div className="text-sm text-fg-subtle mb-3">Loading trajectory…</div>
      )}
      {trajectory === "error" && (
        <div className="text-sm text-danger mb-3 flex flex-wrap items-center gap-2">
          <span>
            Trajectory unavailable. The session may not have any events yet, or the
            sandbox worker is unreachable.
          </span>
          {onRetry && (
            <Button variant="outline" size="xs" onClick={onRetry}>Retry</Button>
          )}
        </div>
      )}
      {trajectory === undefined && !fallback && (
        <div className="text-sm text-fg-subtle">No trajectory loaded yet.</div>
      )}
      {ready && (
        <div className="flex flex-col gap-4">
          <TrajectoryInspector trajectory={trajectory} events={envelopeEvents ?? []} />
          <section aria-label="Raw JSON" className="flex flex-col gap-1">
            <h3 className="text-[11px] uppercase tracking-wide text-fg-subtle">Raw JSON · oma.trajectory.v1</h3>
            <pre className="font-mono text-xs bg-bg-surface rounded px-3 py-2 overflow-auto max-h-[40vh] text-fg whitespace-pre">
              {json}
            </pre>
          </section>
        </div>
      )}
      {fallback && <TrajectoryInspector events={fallback} />}
    </Modal>
  );
}
