import type {
  Model,
  ModelLifecycle,
} from "@open-managed-agents/managed-agents-application";

/**
 * Lifecycle stages a catalogue lists when the caller does not ask for a
 * specific set. Retired models stay hidden unless `retired` is requested
 * explicitly, matching the Anthropic Models API semantics.
 */
export const DEFAULT_VISIBLE_LIFECYCLES: readonly ModelLifecycle[] = [
  "active",
  "deprecated",
];

export function filterModelsByLifecycle(
  models: Model[],
  lifecycle: ModelLifecycle[] | undefined,
): Model[] {
  const visible = lifecycle === undefined || lifecycle.length === 0
    ? DEFAULT_VISIBLE_LIFECYCLES
    : lifecycle;
  const allowed = new Set<ModelLifecycle>(visible);
  return models.filter((model) => allowed.has(model.lifecycle));
}
