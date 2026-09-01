import type {
  BetaManagedAgentsEventParams,
  BetaManagedAgentsUserDefineOutcomeEventParams,
  BetaManagedAgentsUserMessageEventParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { z } from "zod";

export const textBlockSchema = z
  .object({ type: z.literal("text"), text: z.string() })
  .strict();

const imageSourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("base64"),
      data: z.string(),
      media_type: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal("url"), url: z.string().min(1) }).strict(),
  z.object({ type: z.literal("file"), file_id: z.string().min(1) }).strict(),
]);

const documentSourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("base64"),
      data: z.string(),
      media_type: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("text"),
      data: z.string(),
      media_type: z.literal("text/plain"),
    })
    .strict(),
  z.object({ type: z.literal("url"), url: z.string().min(1) }).strict(),
  z.object({ type: z.literal("file"), file_id: z.string().min(1) }).strict(),
]);

const imageBlockSchema = z
  .object({ type: z.literal("image"), source: imageSourceSchema })
  .strict();

const documentBlockSchema = z
  .object({
    type: z.literal("document"),
    source: documentSourceSchema,
    context: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
  })
  .strict();

export const redactedBlockSchema = z
  .object({ type: z.literal("redacted") })
  .strict();

const searchResultBlockSchema = z
  .object({
    type: z.literal("search_result"),
    citations: z.object({ enabled: z.boolean() }).strict(),
    content: z.array(textBlockSchema),
    source: z.string(),
    title: z.string(),
  })
  .strict();

export const userMessageContentSchema = z.union([
  textBlockSchema,
  imageBlockSchema,
  documentBlockSchema,
  redactedBlockSchema,
]);

export const toolResultContentSchema = z.union([
  textBlockSchema,
  imageBlockSchema,
  documentBlockSchema,
  searchResultBlockSchema,
]);

export const rubricSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), content: z.string() }).strict(),
  z.object({ type: z.literal("file"), file_id: z.string().min(1) }).strict(),
]);

export const userMessageEventInputSchema = z
    .object({
      type: z.literal("user.message"),
      content: z.array(userMessageContentSchema),
    })
    .strict() satisfies z.ZodType<BetaManagedAgentsUserMessageEventParams>;

export const userDefineOutcomeEventInputSchema = z
    .object({
      type: z.literal("user.define_outcome"),
      description: z.string(),
      rubric: rubricSchema,
      max_iterations: z.number().int().min(1).max(20).nullable().optional(),
    })
    .strict() satisfies z.ZodType<BetaManagedAgentsUserDefineOutcomeEventParams>;

export const sendableEventSchema = z.discriminatedUnion("type", [
    userMessageEventInputSchema,
    z
      .object({
        type: z.literal("user.interrupt"),
        session_thread_id: z.string().nullable().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("user.tool_confirmation"),
        result: z.enum(["allow", "deny"]),
        tool_use_id: z.string().min(1),
        deny_message: z.string().nullable().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("user.custom_tool_result"),
        custom_tool_use_id: z.string().min(1),
        content: z.array(toolResultContentSchema).optional(),
        is_error: z.boolean().nullable().optional(),
      })
      .strict(),
    userDefineOutcomeEventInputSchema,
    z
      .object({
        type: z.literal("user.tool_result"),
        tool_use_id: z.string().min(1),
        content: z.array(toolResultContentSchema).optional(),
        is_error: z.boolean().nullable().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("system.message"),
        content: z.array(textBlockSchema),
      })
      .strict(),
  ]) satisfies z.ZodType<BetaManagedAgentsEventParams>;
