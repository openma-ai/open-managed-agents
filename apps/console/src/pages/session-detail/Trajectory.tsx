import {
  rewardHeadline,
  outcomeToStatusTone,
  type Trajectory,
} from "../../lib/trajectory";
import { StatusPill } from "../../components/Badge";
import { Modal } from "../../components/Modal";
import { Button } from "@/components/ui/button";

/**
 * Session-detail trajectory views.
 *
 * Three pieces:
 *   - `TrajectoryOutcomeChip` — small "Outcome: X" pill rendered in the
 *     session header. Hidden while loading / on error / when the agent
 *     is still running.
 *   - `TrajectoryRewardChip` — paired pill showing the verifier's reward
 *     score. Tooltip reveals the verifier id + computed-at timestamp.
 *   - `TrajectoryViewerModal` — Phase-3 viewer: pretty-printed JSON with
 *     a Download button. Anthropic Messages / Inspect AI / OTel
 *     projections are Phase 4.
 *
 * Lifted out of SessionDetail to keep the orchestrator focused on event
 * stream + chat scaffolding.
 */

export function TrajectoryOutcomeChip({
  trajectory,
}: {
  trajectory: Trajectory | "loading" | "error" | undefined;
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
  trajectory: Trajectory | "loading" | "error" | undefined;
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

/** Trajectory viewer modal — Phase 3 minimum-viable: pretty-printed
 *  JSON with a Download button. The download uses an in-memory blob URL
 *  so we don't have to round-trip to a server endpoint. */
export function TrajectoryViewerModal({
  open,
  onClose,
  sessionId,
  trajectory,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  trajectory: Trajectory | "loading" | "error" | undefined;
}) {
  const ready = trajectory && trajectory !== "loading" && trajectory !== "error";
  const json = ready ? JSON.stringify(trajectory, null, 2) : "";

  function download() {
    if (!ready) return;
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Trajectory"
      subtitle={ready ? `${trajectory.trajectory_id} · session ${sessionId}` : `session ${sessionId}`}
      maxWidth="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={download} disabled={!ready}>Download JSON</Button>
        </>
      }
    >
      {trajectory === "loading" && (
        <div className="text-sm text-fg-subtle">Loading trajectory…</div>
      )}
      {trajectory === "error" && (
        <div className="text-sm text-danger">
          Trajectory unavailable. The session may not have any events yet, or the
          sandbox worker is unreachable. Retry by reloading the page.
        </div>
      )}
      {trajectory === undefined && (
        <div className="text-sm text-fg-subtle">No trajectory loaded yet.</div>
      )}
      {ready && (
        <pre className="font-mono text-[11px] bg-bg-surface rounded px-3 py-2 overflow-auto max-h-[60vh] text-fg whitespace-pre">
          {json}
        </pre>
      )}
    </Modal>
  );
}
