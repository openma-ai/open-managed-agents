import { useMemo, type ReactNode } from "react";
import { AgentChatView } from "@openma/common/chat-ui";
import type { CanonicalChatTurn } from "@openma/common/session-events/managed";
import {
  CanonicalSessionTurn,
  projectCanonicalSessionTurn,
} from "./CanonicalSessionTurn";

export interface ManagedSessionConversationProps {
  afterTurns?: ReactNode;
  beforeComposer?: ReactNode;
  composer: ReactNode;
  empty?: ReactNode;
  sessionId?: string;
  turns: readonly CanonicalChatTurn[];
}

/**
 * Console supplies data and product slots; OpenMA UI owns the transcript,
 * scroll anchoring, shared turn lifecycle, and composer column.
 */
export function ManagedSessionConversation({
  afterTurns,
  beforeComposer,
  composer,
  empty,
  sessionId,
  turns,
}: ManagedSessionConversationProps) {
  const projectedTurns = useMemo(
    () => turns.map(projectCanonicalSessionTurn),
    [turns],
  );
  const sourceTurns = useMemo(
    () => new Map(turns.map((turn) => [turn.id, turn])),
    [turns],
  );

  return (
    <AgentChatView
      className="flex-1 min-h-0"
      phase="active"
      renderTurn={({ turn }) => {
        const source = sourceTurns.get(turn.id);
        return source ? (
          <CanonicalSessionTurn
            projectedTurn={turn}
            sessionId={sessionId}
            turn={source}
          />
        ) : null;
      }}
      sessionId={sessionId}
      slots={{
        composer,
        beforeComposer,
        conversationContentAfter: afterTurns,
        empty: empty ?? (
          <p className="text-sm text-fg-muted">Send a message to start this session.</p>
        ),
      }}
      surface="console"
      turns={projectedTurns}
    />
  );
}
