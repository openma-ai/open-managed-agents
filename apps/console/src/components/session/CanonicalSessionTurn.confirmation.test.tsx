import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  pendingManagedActions,
  projectCanonicalChat,
  type WireSessionEvent,
} from "@openma/common/session-events/managed";
import { QueueDock, ToolConfirmationAsk } from "@openma/common/chat-ui";
import {
  CanonicalSessionTurn,
  projectCanonicalSessionTurn,
} from "./CanonicalSessionTurn";
import { encodeGuiToolConfirmation } from "../../lib/managed-event-bridge";
import { getStatusBadge } from "../ai-elements/tool";

function askEvents(): WireSessionEvent[] {
  return [
    {
      type: "user.message",
      id: "u1",
      content: [{ type: "text", text: "deploy prod" }],
    },
    { type: "session.status_running" },
    {
      type: "agent.tool_use",
      id: "tool_ask",
      name: "bash",
      input: { command: "deploy --prod" },
      evaluated_permission: "ask",
    },
    {
      type: "session.status_idle",
      stop_reason: {
        type: "requires_action",
        event_ids: ["tool_ask"],
      },
    },
  ];
}

describe("always_ask tool confirmation (#355)", () => {
  it("projects awaiting + pending tool status (not completed)", () => {
    const projection = projectCanonicalChat(askEvents(), { sessionStatus: "idle" });
    expect(projection.sessionState).toBe("requires_action");
    expect(projection.turns.map((t) => t.status)).toEqual(["awaiting"]);
    expect(projection.awaitingToolCallIds).toEqual(["tool_ask"]);
    const tool = projection.turns[0]!.render.tools.find((t) => t.toolCallId === "tool_ask");
    expect(tool?.status).toBe("pending");
  });

  it("maps parked tools to pending under awaiting (badge is Awaiting Approval)", () => {
    const projection = projectCanonicalChat(askEvents(), { sessionStatus: "idle" });
    const turn = projection.turns[0]!;
    const projected = projectCanonicalSessionTurn(turn, {
      activeTurnId: projection.activeTurnId,
    });
    const tools = projected.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ id: "tool_ask", status: "pending" });
    const html = renderToStaticMarkup(
      <CanonicalSessionTurn turn={turn} projectedTurn={projected} />,
    );
    expect(html).toContain("Needs action");
    expect(html).toContain("waiting on bash");
    const badge = renderToStaticMarkup(<>{getStatusBadge("approval-requested")}</>);
    expect(badge).toContain("Awaiting Approval");
    expect(renderToStaticMarkup(<>{getStatusBadge("output-available")}</>)).toContain(
      "Completed",
    );
  });

  it("exposes confirmation actions and Allow/Deny controls", () => {
    const actions = pendingManagedActions(askEvents()).filter(
      (a) => a.type === "confirmation",
    );
    expect(actions).toMatchObject([{ id: "tool_ask", type: "confirmation" }]);
    const html = renderToStaticMarkup(
      <ToolConfirmationAsk actions={actions} onSubmit={() => undefined} />,
    );
    expect(html).toContain('data-tool-confirmation-allow="true"');
    expect(html).toContain('data-tool-confirmation-deny="true"');
    expect(html).toContain("bash");
  });

  it("SessionDetail composer contract: empty queue stays hidden under parked ask", () => {
    // Mirrors SessionDetail wiring: ToolConfirmationAsk occupies the composer
    // slot; QueueDock only mounts when prompts.length > 0.
    const actions = pendingManagedActions(askEvents()).filter(
      (a) => a.type === "confirmation",
    );
    const queuePrompts: { id: string; text: string }[] = [];
    const html = renderToStaticMarkup(
      <>
        {queuePrompts.length > 0 ? (
          <QueueDock
            blocked={{
              reason: "requires_action",
              toolNames: ["bash"],
              toolCallIds: ["tool_ask"],
            }}
            prompts={queuePrompts}
          />
        ) : null}
        <ToolConfirmationAsk actions={actions} onSubmit={() => undefined} />
      </>,
    );
    expect(html).toContain('data-tool-confirmation="true"');
    expect(html).toContain('data-tool-confirmation-allow="true"');
    expect(html).not.toContain("data-composer-queue");
    expect(html).not.toContain("data-queue-blocked");
    expect(html).not.toContain("0 queued");
    expect(html).not.toContain("waiting on tool");
  });

  it("encodeGuiToolConfirmation payload matches CMA user.tool_confirmation", () => {
    const allow = encodeGuiToolConfirmation({
      sessionId: "sess",
      toolUseId: "tool_ask",
      result: "allow",
      eventId: "e1",
    });
    expect(allow.ok).toBe(true);
    if (!allow.ok) return;
    expect(allow.wire).toEqual({
      type: "user.tool_confirmation",
      tool_use_id: "tool_ask",
      result: "allow",
    });
  });
});
