/**
 * `feishu-scheduled-report`: on the Loop's schedule, run the Agent on the
 * configured task and post what it wrote to Feishu chats, as the bot. The
 * schedule itself is a host field (see ../schedule.ts); the template only
 * says what a tick means. The Agent's tools and credentials, such as data
 * warehouse access or a code repository, come from the Agent and the Loop's
 * session settings, not from here.
 */

import { feishuMarkdownCard } from "@openma/matter-feishu/bond";
import { defineLoop, sessionBinding, sessionScopeField } from "@openma/matter-loop";
import { SCHEDULE_TICK } from "../schedule.js";

const chatIdOf = (resource: string): string | undefined => {
  const id = resource.startsWith("chat:") ? resource.slice("chat:".length) : resource;
  return id.startsWith("oc_") ? id : undefined;
};

export const feishuScheduledReport = defineLoop(
  {
    id: "feishu-scheduled-report",
    version: "1.0.0",
    description: "Run an Agent on a schedule and post its report to Feishu chats",
    spec: {
      sources: [SCHEDULE_TICK],
      workThread: "schedule",
      session: "per-work-thread",
      reaction: "effects",
    },
    runAs: "app",
    requiredBonds: [{ provider: "feishu", operations: ["im_send"], runAs: "app" }],
    configSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", minLength: 1, title: "Agent", "x-oma-widget": "agent" },
        chats: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          title: "Chats",
          description: "Group chats the report is posted to. The bot must be in each.",
          "x-oma-widget": "bond-resources",
          "x-bond-provider": "feishu",
        },
        task: {
          type: "string",
          minLength: 1,
          maxLength: 8000,
          title: "Task",
          description: "What the Agent does on each run. Its final answer is posted as the report.",
        },
        sessionScope: sessionScopeField({
          scopes: ["request", "global"],
          describe: {
            request: "request: a new Session for every run",
            global: "global: one Session for every run, so the Agent sees earlier reports",
          },
        }),
      },
      required: ["agentId", "chats", "task"],
    },
  },
  (app, { config }) =>
    app.on(SCHEDULE_TICK, async (work) => {
      const authority = work.event.source.authority;
      const chats = (Array.isArray(config.chats) ? config.chats : [])
        .map((c) => (typeof c === "string" ? chatIdOf(c) : undefined))
        .filter((c): c is string => c !== undefined);
      if (chats.length === 0) return work.react.none("No chat to post to");
      const payload = (work.event.payload ?? {}) as { scheduledAt?: unknown };
      const scheduledAt = typeof payload.scheduledAt === "string" ? payload.scheduledAt : work.event.occurredAt;
      const binding = sessionBinding(config.sessionScope, {
        scopeId: `feishu:${authority}:schedule`,
        default: "request",
        threads: { global: "schedule", request: `request:${work.event.id}` },
      });
      const context = await work.context.project({
        scopeId: binding.scopeId,
        workThreadId: binding.workThreadId,
        items: [
          work.context.event(),
          work.context.value({
            kind: "instructions",
            value:
              `This is a scheduled run (${scheduledAt}). ${String(config.task)}\n\n` +
              "Your final answer is posted to the team's Feishu chat as the report, " +
              "as Feishu card markdown (headings, lists, links, code). Write only the report.",
            provenance: [{ sourceType: "loop-template", sourceId: "feishu-scheduled-report" }],
          }),
        ],
        grants: ["feishu.message.send"],
      });
      const turn = await work.agent(String(config.agentId)).session(binding).turn({ context, allow: [] });
      const report = typeof turn.output === "string" ? turn.output.trim() : "";
      if (turn.outcome !== "completed" || report === "") {
        return work.react.none(
          turn.outcome === "completed" ? "The Agent wrote no report" : `The Agent Turn ended ${turn.outcome}`,
        );
      }
      const effects = await Promise.all(
        chats.map((chatId) =>
          work.effect(context, {
            integrationId: "feishu",
            operation: "message.send",
            input: { authority, chatId, card: feishuMarkdownCard(report) },
          }),
        ),
      );
      return work.react.effects(effects);
    }),
);
