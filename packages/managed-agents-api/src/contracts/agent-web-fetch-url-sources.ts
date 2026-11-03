import type {
  BetaManagedAgentsWebFetchURLSourceToolFilter,
  BetaManagedAgentsWebFetchURLSourceToolFilterParams,
  BetaManagedAgentsWebFetchURLSourceUserInput,
  BetaManagedAgentsWebFetchURLSourceUserInputParams,
  BetaManagedAgentsWebFetchURLSources,
  BetaManagedAgentsWebFetchURLSourcesParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import { z } from "zod";

/** Names one tool in an `only` or `except` list. */
const webFetchURLSourceToolReferenceSchema = z
  .object({
    name: z.string(),
    type: z.literal("tool_reference"),
  })
  .strict();

const webFetchURLSourceAllSchema = z.object({ type: z.literal("all") }).strict();

const webFetchURLSourceNoneSchema = z
  .object({ type: z.literal("none") })
  .strict();

const webFetchURLSourceOnlySchema = z
  .object({
    tools: z.array(webFetchURLSourceToolReferenceSchema),
    type: z.literal("only"),
  })
  .strict();

const webFetchURLSourceExceptSchema = z
  .object({
    tools: z.array(webFetchURLSourceToolReferenceSchema),
    type: z.literal("except"),
  })
  .strict();

/** Response form of a tool filter: the object form only. */
export const webFetchURLSourceToolFilterSchema: z.ZodType<BetaManagedAgentsWebFetchURLSourceToolFilter> =
  z.discriminatedUnion("type", [
    webFetchURLSourceAllSchema,
    webFetchURLSourceNoneSchema,
    webFetchURLSourceOnlySchema,
    webFetchURLSourceExceptSchema,
  ]);

/** Response form of the user-input source: the object form only. */
export const webFetchURLSourceUserInputSchema: z.ZodType<BetaManagedAgentsWebFetchURLSourceUserInput> =
  z.discriminatedUnion("type", [
    webFetchURLSourceAllSchema,
    webFetchURLSourceNoneSchema,
  ]);

/** Request form of a tool filter: the `"all"` / `"none"` shorthand is accepted too. */
export const webFetchURLSourceToolFilterParamsSchema: z.ZodType<BetaManagedAgentsWebFetchURLSourceToolFilterParams> =
  z.union([
    z.enum(["all", "none"]),
    webFetchURLSourceToolFilterSchema,
  ]);

/** Request form of the user-input source: the `"all"` / `"none"` shorthand is accepted too. */
export const webFetchURLSourceUserInputParamsSchema: z.ZodType<BetaManagedAgentsWebFetchURLSourceUserInputParams> =
  z.union([
    z.enum(["all", "none"]),
    webFetchURLSourceUserInputSchema,
  ]);

/** Response form of the `url_sources` config; every key is always present. */
export const webFetchURLSourcesSchema: z.ZodType<BetaManagedAgentsWebFetchURLSources> =
  z
    .object({
      client_tool_results: webFetchURLSourceToolFilterSchema.nullable(),
      server_tool_results: webFetchURLSourceToolFilterSchema.nullable(),
      user_input: webFetchURLSourceUserInputSchema.nullable(),
    })
    .strict();

/** Request form of the `url_sources` config; every key is optional. */
export const webFetchURLSourcesParamsSchema: z.ZodType<BetaManagedAgentsWebFetchURLSourcesParams> =
  z
    .object({
      client_tool_results: webFetchURLSourceToolFilterParamsSchema
        .nullable()
        .optional(),
      server_tool_results: webFetchURLSourceToolFilterParamsSchema
        .nullable()
        .optional(),
      user_input: webFetchURLSourceUserInputParamsSchema.nullable().optional(),
    })
    .strict();
