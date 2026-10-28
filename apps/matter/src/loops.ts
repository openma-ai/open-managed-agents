/**
 * The Loop templates this service runs, and the checks a Loop's
 * configuration passes before it is saved. A Loop is a template plus its
 * configuration on one Bond; the answering Agent is a configuration field
 * (`agentId`), never a property of the Bond.
 *
 * Templates are code: the built-in ones below, plus any a deployment
 * registers at startup with `registerLoopTemplates` (see README.md,
 * "Deployment Loops"). Nothing is loaded at runtime from users.
 */

import { feishuTemplates } from "@openma/matter-feishu/bond";
import { gitlabTemplates } from "@openma/matter-gitlab/bond";
import type { MatterApplication } from "./adapter.js";
import type { LoopRecord } from "./persistence.js";
import type { LoopIssue } from "./issues.js";
import { isScheduled, SCHEDULE_FIELDS, scheduledLoop, scheduleIssue, type LoopSchedule } from "./schedule.js";
import { feishuScheduledReport } from "./templates/feishu-report.js";

/** A Loop written with `defineLoop` from `@openma/matter-loop`. */
export type LoopTemplate = (typeof feishuTemplates)[number];

/** One template as a host lists it, with the Bond provider it runs on. */
export interface LoopTemplateEntry {
  readonly provider: "feishu" | "gitlab";
  readonly loop: LoopTemplate;
  /** Display name in the Console; defaults to the definition id. */
  readonly name?: string;
}

const BUILT_IN: readonly LoopTemplateEntry[] = [
  ...feishuTemplates.map((loop) => ({ provider: "feishu" as const, loop })),
  { provider: "feishu", loop: feishuScheduledReport },
  ...gitlabTemplates.map((loop) => ({ provider: "gitlab" as const, loop })),
];

let registered: readonly LoopTemplateEntry[] = [];

/** Every template: the built-in ones, then the deployment's. */
export const loopTemplates = (): readonly LoopTemplateEntry[] => [...BUILT_IN, ...registered];

export const loopTemplate = (id: string): LoopTemplateEntry | undefined =>
  loopTemplates().find((entry) => entry.loop.definition.id === id);

/**
 * Adds a deployment's own Loop templates. Call it once at startup, before the
 * service starts. Throws, adding none, if an entry runs on an unknown
 * provider, is not a Loop, or reuses a template id.
 */
export const registerLoopTemplates = (entries: readonly LoopTemplateEntry[]): void => {
  const problems: string[] = [];
  const ids = new Set(loopTemplates().map((entry) => entry.loop.definition.id));
  for (const entry of entries) {
    const id = entry.loop?.definition?.id;
    if (typeof id !== "string" || id === "" || typeof entry.loop.install !== "function") {
      problems.push("each entry needs a Loop made with defineLoop");
      continue;
    }
    if (entry.provider !== "feishu" && entry.provider !== "gitlab") {
      problems.push(`${id}: provider must be feishu or gitlab`);
    }
    if (ids.has(id)) problems.push(`${id}: a template with this id already exists`);
    const properties = Object.keys(
      ((entry.loop.definition.configSchema ?? {}) as ObjectSchema).properties ?? {},
    );
    for (const name of properties.filter((p) => RESERVED_FIELDS.has(p))) {
      problems.push(`${id}: ${name} is a host field; the template cannot define it`);
    }
    ids.add(id);
  }
  if (problems.length > 0) throw new LoopConfigError(problems);
  registered = [...registered, ...entries];
};

/** For tests: forget the registered templates. */
export const resetLoopTemplates = (): void => {
  registered = [];
};

/** The most Memory Stores OpenMA mounts in one Session. */
const MAX_MEMORY_STORES = 8;

/**
 * The OpenMA session a Loop opens, next to the Agent: the environment it runs
 * in (its sandbox image, packages and network), the vaults attached to it
 * (credentials, including environment variables), the git repositories
 * cloned into it and the Memory Stores mounted in it. The host adds these
 * fields to every template; a template never sees them. Empty keeps the
 * service's default environment, only the vault Matter makes for each
 * session, no repository and no Memory Store.
 */
export const SESSION_FIELDS = {
  environmentId: {
    type: "string",
    title: "Environment",
    "x-oma-widget": "environment",
    "x-oma-section": "session",
  },
  vaultIds: {
    type: "array",
    items: { type: "string", minLength: 1 },
    default: [],
    title: "Vaults",
    "x-oma-widget": "vault",
    "x-oma-section": "session",
  },
  repositories: {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: 2048 },
    default: [],
    title: "Repositories",
    description:
      "Git repositories cloned into each Session, by URL. The workspace's GitLab Bond for each " +
      "URL's instance clones them, and fetches again before later runs; the Agent never sees its token.",
    "x-oma-widget": "repositories",
    "x-oma-section": "session",
  },
  memoryStores: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 256, title: "Memory Store" },
        access: { type: "string", enum: ["read_write", "read_only"], default: "read_write", title: "Access" },
      },
      required: ["id"],
    },
    // OpenMA mounts at most 8 Memory Stores in one Session.
    maxItems: MAX_MEMORY_STORES,
    default: [],
    title: "Memory Stores",
    description:
      "Memory Stores mounted in each Session at /mnt/memory/<store name>/, read-write unless read-only. " +
      "What the Agent writes there outlives the Session.",
    "x-oma-widget": "memory-stores",
    "x-oma-section": "session",
  },
} as const;

/** Configuration fields the host owns; a template cannot define them. */
const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  "bond",
  ...Object.keys(SESSION_FIELDS),
  ...Object.keys(SCHEDULE_FIELDS),
]);

/** The host fields a template gets, after its own. */
export const hostFields = (loop: LoopTemplate): Readonly<Record<string, PropertySchema>> => ({
  ...(isScheduled(loop) ? SCHEDULE_FIELDS : {}),
  ...SESSION_FIELDS,
});

/** The session settings of a Loop's saved configuration. */
export interface LoopSession {
  readonly environmentId?: string;
  readonly vaultIds: readonly string[];
  /** Repository URLs, each cloned with the workspace's GitLab Bond for it. */
  readonly repositories: readonly string[];
  /** Memory Stores mounted in the session, at `/mnt/memory/<store name>/`. */
  readonly memoryStores: readonly LoopMemoryStore[];
}

/** One Memory Store a Loop mounts in its sessions. */
export interface LoopMemoryStore {
  readonly id: string;
  readonly access: "read_write" | "read_only";
}

/** The Memory Stores of a saved configuration; a store without `access` is read-write. */
const readMemoryStores = (value: unknown): LoopMemoryStore[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const { id, access } = entry as { id?: unknown; access?: unknown };
        if (typeof id !== "string" || id === "") return [];
        return [{ id, access: access === "read_only" ? ("read_only" as const) : ("read_write" as const) }];
      })
    : [];

/** Splits a saved configuration into the template's part, the session and the schedule. */
export const splitLoopConfig = (
  config: Readonly<Record<string, unknown>>,
): {
  readonly config: Record<string, unknown>;
  readonly session: LoopSession;
  readonly schedule?: { readonly schedule: string; readonly timezone: string };
} => {
  const { environmentId, vaultIds, repositories, memoryStores, schedule, timezone, ...rest } = config;
  return {
    config: rest,
    ...(typeof schedule === "string" && schedule !== ""
      ? { schedule: { schedule, timezone: typeof timezone === "string" && timezone !== "" ? timezone : "UTC" } }
      : {}),
    session: {
      ...(typeof environmentId === "string" && environmentId !== "" ? { environmentId } : {}),
      vaultIds: Array.isArray(vaultIds)
        ? vaultIds.filter((id): id is string => typeof id === "string" && id !== "")
        : [],
      repositories: Array.isArray(repositories)
        ? repositories.filter((r): r is string => typeof r === "string" && r !== "")
        : [],
      memoryStores: readMemoryStores(memoryStores),
    },
  };
};

/** Defaults this service applies on top of a template's own. */
const HOST_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // The "GET" (了解) reaction on a message the bot took.
  "feishu-agent": { acknowledge: "Get" },
};

export class LoopConfigError extends Error {
  readonly problems: readonly string[];
  /** The same problems with field, code and params, for translation. */
  readonly issues: readonly LoopIssue[];
  constructor(problems: readonly (string | LoopIssue)[]) {
    const issues = problems.map((p) => (typeof p === "string" ? { code: "invalid", message: p } : p));
    super(issues.map((i) => i.message).join("; "));
    this.name = "LoopConfigError";
    this.issues = issues;
    this.problems = issues.map((i) => i.message);
  }
}

interface PropertySchema {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly items?: PropertySchema;
  readonly properties?: Readonly<Record<string, PropertySchema>>;
  readonly required?: readonly string[];
  readonly default?: unknown;
  readonly title?: string;
}

interface ObjectSchema {
  readonly properties?: Readonly<Record<string, PropertySchema>>;
  readonly required?: readonly string[];
}

const checkValue = (
  field: string,
  label: string,
  schema: PropertySchema,
  value: unknown,
  issues: LoopIssue[],
  item?: number,
): void => {
  const add = (code: string, message: string, extra: Record<string, string | number> = {}) => {
    const params: Record<string, string | number> = item === undefined ? extra : { ...extra, item };
    issues.push({ field, code, message, ...(Object.keys(params).length > 0 ? { params } : {}) });
  };
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        add("type", `${label} must be a string`, { expected: "string" });
        return;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) add("required", `${label} is required`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        add("max_length", `${label} must be at most ${schema.maxLength} characters`, { max: schema.maxLength });
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") add("type", `${label} must be true or false`, { expected: "boolean" });
      break;
    case "array":
      if (!Array.isArray(value)) {
        add("type", `${label} must be a list`, { expected: "list" });
        return;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        add("min_items", `${label} needs at least ${schema.minItems}`, { min: schema.minItems });
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        add("max_items", `${label} takes at most ${schema.maxItems}`, { max: schema.maxItems });
      }
      if (schema.items !== undefined) {
        value.forEach((entry, i) => checkValue(field, `${label}[${i}]`, schema.items!, entry, issues, i + 1));
      }
      break;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        add("type", `${label} must be an object`, { expected: "object" });
        return;
      }
      const entry = value as Record<string, unknown>;
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        if (entry[key] === undefined) {
          if (schema.required?.includes(key)) add("required", `${label}.${key} is required`);
          continue;
        }
        checkValue(field, `${label}.${key}`, property, entry[key], issues, item);
      }
      break;
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    add("enum", `${label} must be one of ${schema.enum.join(", ")}`, { options: schema.enum.join(", ") });
  }
};

/**
 * The configuration to save for `template`: unknown fields dropped, defaults
 * filled in, every field checked against the template's schema.
 */
export const normalizeLoopConfig = (template: string, input: unknown): Record<string, unknown> => {
  const entry = loopTemplate(template);
  if (entry === undefined) throw new LoopConfigError([`Unknown Loop template ${template}`]);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new LoopConfigError(["config must be an object"]);
  }
  const schema = (entry.loop.definition.configSchema ?? {}) as ObjectSchema;
  const given = input as Record<string, unknown>;
  const config: Record<string, unknown> = {};
  const problems: LoopIssue[] = [];
  const properties: Record<string, PropertySchema> = { ...(schema.properties ?? {}), ...hostFields(entry.loop) };
  const required = [...(schema.required ?? []), ...(isScheduled(entry.loop) ? ["schedule"] : [])];
  for (const [name, property] of Object.entries(properties)) {
    const value =
      given[name] !== undefined ? given[name] : (HOST_DEFAULTS[template]?.[name] ?? property.default);
    if (value === undefined) {
      if (required.includes(name)) {
        problems.push({ field: name, code: "required", message: `${property.title ?? name} is required` });
      }
      continue;
    }
    checkValue(name, property.title ?? name, property, value, problems);
    config[name] = value;
  }
  if (Array.isArray(config.memoryStores)) {
    // Fill each store's defaults (read-write) and drop unknown keys, so the
    // saved configuration says what the Session gets.
    const stores = config.memoryStores as unknown[];
    if (stores.every((s) => typeof s === "object" && s !== null && !Array.isArray(s))) {
      config.memoryStores = stores.map((s) => {
        const { id, access } = s as { id?: unknown; access?: unknown };
        return { id, access: access ?? "read_write" };
      });
    }
    const ids = stores.map((s) => (s as { id?: unknown } | null)?.id).filter((id) => typeof id === "string");
    const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
    if (repeated !== undefined) {
      problems.push({
        field: "memoryStores",
        code: "duplicate",
        params: { id: repeated },
        message: `Memory Store ${repeated} is listed twice`,
      });
    }
  }
  if (isScheduled(entry.loop) && config.schedule !== undefined) {
    const problem = scheduleIssue(config.schedule, config.timezone);
    if (problem !== undefined) problems.push(problem);
  }
  if (problems.length > 0) throw new LoopConfigError(problems);
  return config;
};

/**
 * Installs a connection's Loops (their configurations already without host
 * fields, see `loopDrivers`), renaming each scheduled one's tick to its own.
 */
export const installLoops = (
  application: MatterApplication,
  loops: readonly LoopRecord[],
  provider: LoopTemplateEntry["provider"],
): void => {
  for (const loop of loops) {
    const template = loopTemplate(loop.template);
    if (template?.provider !== provider) {
      throw new Error(`Loop ${loop.id}: ${loop.template} does not run on ${provider === "feishu" ? "Feishu" : "GitLab"}`);
    }
    const definition = isScheduled(template.loop) ? scheduledLoop(template.loop, loop.id) : template.loop;
    application.loop(definition, loop.config as Parameters<typeof application.loop>[1]);
  }
};

/** The schedules of a connection's scheduled Loops, from their saved configurations. */
export const loopSchedules = (loops: readonly LoopRecord[]): LoopSchedule[] =>
  loops.flatMap((loop) => {
    const template = loopTemplate(loop.template);
    if (template === undefined || !isScheduled(template.loop)) return [];
    const { schedule } = splitLoopConfig(loop.config);
    return schedule === undefined ? [] : [{ loopId: loop.id, ...schedule }];
  });
