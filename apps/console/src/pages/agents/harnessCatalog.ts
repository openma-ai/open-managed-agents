import { z } from "zod";

// Public deployment metadata only; never accept factory or private configuration into the UI.
const descriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string(),
  execution: z.object({ placement: z.enum(["host", "sandbox", "runtime", "unknown"]) }),
  capabilities: z.object({ runtime_binding: z.boolean().nullable() }),
  requirements: z.array(z.string().min(1)),
});
export const harnessCatalogSchema = z.object({
  object: z.literal("list"),
  data: z.array(descriptorSchema),
  default_harness_id: z.string().min(1).nullable(),
});
export type HarnessCatalog = z.infer<typeof harnessCatalogSchema>;
export type HarnessDescriptor = HarnessCatalog["data"][number];

export function openMaFields(config: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const value = config?._oma;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function resolvedHarness(catalog: HarnessCatalog, value: unknown): HarnessDescriptor | undefined {
  const id = value == null || value === "default" ? catalog.default_harness_id : value;
  return catalog.data.find((entry) => entry.id === id);
}

function hasConfiguredPath(fields: Record<string, unknown>, path: string): boolean {
  let value: unknown = fields;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return false;
    value = (value as Record<string, unknown>)[part];
  }
  return !(value == null || (typeof value === "string" && !value.trim()));
}

/** Requirement `a|b` is satisfied when any alternative path is configured. */
export function missingHarnessRequirements(descriptor: HarnessDescriptor, fields: Record<string, unknown>): string[] {
  return descriptor.requirements.filter((requirement) =>
    !requirement.split("|").some((path) => hasConfiguredPath(fields, path)));
}

export function formatHarnessRequirement(requirement: string): string {
  return requirement.split("|").map((path) => `_oma.${path}`).join(" or ");
}

export function harnessValidationError(catalog: HarnessCatalog, value: unknown, fields: Record<string, unknown>): string {
  const descriptor = resolvedHarness(catalog, value);
  if (!descriptor) {
    return value == null || value === "default"
      ? "No deployment default harness is available. Choose a registered implementation."
      : `Harness \"${String(value)}\" is not registered in this deployment. Its configuration is preserved; choose a registered implementation or edit JSON / YAML.`;
  }
  const missing = missingHarnessRequirements(descriptor, fields);
  return missing.length ? `Missing required configuration: ${missing.map(formatHarnessRequirement).join(", ")}. Set it in JSON / YAML; selecting a harness does not install packages.` : "";
}
