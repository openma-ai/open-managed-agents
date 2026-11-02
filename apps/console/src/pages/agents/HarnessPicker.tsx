import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectOption } from "../../components/Select";
import { formatHarnessRequirement, harnessValidationError, missingHarnessRequirements, resolvedHarness, type HarnessCatalog } from "./harnessCatalog";

interface Props {
  value: unknown;
  fields: Record<string, unknown>;
  /** Error from building the current form payload; requirement checks are meaningless until it is fixed. */
  configError?: string;
  onChange: (id: string) => void;
  catalog: HarnessCatalog | null;
  loading: boolean;
  error: string;
  retry: () => void;
}
const placementLabels = {
  host: "Control-plane process", sandbox: "Sandbox", runtime: "Runtime", unknown: "Unspecified by deployment",
};

export function HarnessPicker({ value, fields, configError, onChange, catalog, loading, error, retry }: Props) {
  const selected = value == null || value === "default" ? "default" : String(value);
  const descriptor = catalog ? resolvedHarness(catalog, value) : undefined;
  const unknown = selected !== "default" && !catalog?.data.some((entry) => entry.id === selected);
  const validation = configError || (catalog ? harnessValidationError(catalog, value, fields) : "");
  const defaultDescriptor = catalog ? resolvedHarness(catalog, "default") : undefined;
  // While the payload cannot be built, `fields` is empty, so requirement hints would be false.
  const missingFor = (entry: Parameters<typeof missingHarnessRequirements>[0]) =>
    configError ? [] : missingHarnessRequirements(entry, fields);
  return (
    <section aria-label="Harness configuration" className="min-w-0 space-y-2">
      <Label htmlFor="agent-harness" className="text-sm text-fg-muted block">Harness</Label>
      <Select id="agent-harness" value={selected} onValueChange={onChange}
        disabled={loading || !catalog || catalog.data.length === 0}
        aria-describedby="agent-harness-details" aria-invalid={!!validation}
        className="w-full min-w-0 h-auto min-h-8 whitespace-normal [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:break-all">
        <SelectOption value="default" disabled={!defaultDescriptor || missingFor(defaultDescriptor).length > 0}>
          Default ({catalog?.default_harness_id ?? (loading ? "loading…" : "unavailable")})
        </SelectOption>
        {unknown && <SelectOption value={selected} disabled>{selected}</SelectOption>}
        {catalog?.data.filter((entry) => entry.id !== "default").map((entry) => {
          const missing = missingFor(entry);
          return <SelectOption key={entry.id} value={entry.id} disabled={missing.length > 0}>
            {entry.label} ({entry.id}){missing.length > 0 ? " — requires configuration" : ""}
          </SelectOption>;
        })}
      </Select>
      <div id="agent-harness-details" className="space-y-1 text-xs text-fg-muted break-words">
        {loading && <p role="status">Loading harness catalog…</p>}
        {error && <p role="alert">{error}</p>}
        {catalog?.data.length === 0 && <p role="status">No harnesses are registered in this deployment.</p>}
        {validation && <p role="alert" className="text-danger">{validation}</p>}
        {descriptor && <>
          <p>{descriptor.description}</p>
          <p>Execution strategy: {placementLabels[descriptor.execution.placement]}</p>
          <p>Consumes legacy ACP execution binding: {descriptor.capabilities.runtime_binding === null ? "Unspecified" : descriptor.capabilities.runtime_binding ? "Yes" : "No"}. This does not describe general local-runtime tool access.</p>
          <p>Required advanced fields: {descriptor.requirements.length ? descriptor.requirements.map(formatHarnessRequirement).join(", ") : "None"}.</p>
        </>}
        {catalog && catalog.data.some((entry) => missingFor(entry).length > 0) &&
          <p>Unavailable choices need JSON / YAML configuration: {catalog.data.filter((entry) => missingFor(entry).length > 0).map((entry) => `${entry.label}: ${missingFor(entry).map(formatHarnessRequirement).join(", ")}`).join("; ")}. Selecting a harness does not install packages.</p>}
        <p>Environment is selected when starting a session. Existing ACP and runtime binding configuration is preserved.</p>
      </div>
      {(error || catalog?.data.length === 0) && <Button type="button" variant="outline" size="sm" onClick={retry} disabled={loading}>Retry harness catalog</Button>}
    </section>
  );
}
