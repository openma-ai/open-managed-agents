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

/**
 * The OpenMA session a Loop opens, next to the Agent: the environment it runs
 * in (its sandbox image, packages and network) and the vaults attached to it
 * (credentials, including environment variables). The host adds these fields
 * to every template; a template never sees them. Empty keeps the service's
 * default environment and only the vault Matter makes for each session.
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
} as const;

/** Configuration fields the host owns; a template cannot define them. */
const RESERVED_FIELDS: ReadonlySet<string> = new Set(["bond", ...Object.keys(SESSION_FIELDS)]);

/** The session settings of a Loop's saved configuration. */
export interface LoopSession {
  readonly environmentId?: string;
  readonly vaultIds: readonly string[];
}

/** Splits a saved configuration into the template's part and the session. */
export const splitLoopConfig = (
  config: Readonly<Record<string, unknown>>,
): { readonly config: Record<string, unknown>; readonly session: LoopSession } => {
  const { environmentId, vaultIds, ...rest } = config;
  return {
    config: rest,
    session: {
      ...(typeof environmentId === "string" && environmentId !== "" ? { environmentId } : {}),
      vaultIds: Array.isArray(vaultIds)
        ? vaultIds.filter((id): id is string => typeof id === "string" && id !== "")
        : [],
    },
  };
};

/** Defaults this service applies on top of a template's own. */
const HOST_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // The "GET" (了解) reaction on a message the bot took.
  "feishu-agent": { acknowledge: "Get" },
};

export class LoopConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join("; "));
    this.name = "LoopConfigError";
  }
}

interface PropertySchema {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly items?: PropertySchema;
  readonly default?: unknown;
  readonly title?: string;
}

interface ObjectSchema {
  readonly properties?: Readonly<Record<string, PropertySchema>>;
  readonly required?: readonly string[];
}

const checkValue = (name: string, schema: PropertySchema, value: unknown, problems: string[]): void => {
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        problems.push(`${name} must be a string`);
        return;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${name} is required`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        problems.push(`${name} must be at most ${schema.maxLength} characters`);
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") problems.push(`${name} must be true or false`);
      break;
    case "array":
      if (!Array.isArray(value)) {
        problems.push(`${name} must be a list`);
        return;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        problems.push(`${name} needs at least ${schema.minItems}`);
      }
      if (schema.items !== undefined) {
        value.forEach((item, i) => checkValue(`${name}[${i}]`, schema.items!, item, problems));
      }
      break;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    problems.push(`${name} must be one of ${schema.enum.join(", ")}`);
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
  const problems: string[] = [];
  const properties: Record<string, PropertySchema> = { ...(schema.properties ?? {}), ...SESSION_FIELDS };
  for (const [name, property] of Object.entries(properties)) {
    const value =
      given[name] !== undefined ? given[name] : (HOST_DEFAULTS[template]?.[name] ?? property.default);
    if (value === undefined) {
      if (schema.required?.includes(name)) problems.push(`${property.title ?? name} is required`);
      continue;
    }
    checkValue(property.title ?? name, property, value, problems);
    config[name] = value;
  }
  if (problems.length > 0) throw new LoopConfigError(problems);
  return config;
};
