import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "react-router";
import { useApiQuery } from "../lib/useApiQuery";
import { parseEnvOverlay } from "../lib/env-overlay";
import { Select, SelectOption } from "./Select";

/** The subset of GET /v1/oma/runtimes the picker needs. */
export interface RuntimeOption {
  id: string;
  hostname: string;
  os: string;
  status: "online" | "offline";
}

export function useRuntimeOptions(): { runtimes: RuntimeOption[]; loading: boolean } {
  const { data, isLoading } = useApiQuery<{ runtimes: RuntimeOption[] }>("/v1/oma/runtimes", undefined, {
    retry: false,
  });
  return { runtimes: data?.runtimes ?? [], loading: isLoading };
}

/**
 * "Attach to Runtime" editor for a `self_hosted` Environment: pick one of the
 * caller's paired machines and an Amp `--amp-env`-style overlay (KEY=value
 * lines) the host runner injects into shell/MCP/plugin processes.
 *
 * The Runtime stays a peer resource (managed on the Runtimes page); this only
 * stores a reference to it on the Environment.
 */
export function RuntimeAttachmentFields({
  idPrefix,
  runtimeId,
  onRuntimeIdChange,
  envText,
  onEnvTextChange,
}: {
  idPrefix: string;
  runtimeId: string;
  onRuntimeIdChange: (runtimeId: string) => void;
  envText: string;
  onEnvTextChange: (text: string) => void;
}) {
  const { runtimes, loading } = useRuntimeOptions();
  const missing = runtimeId !== "" && !loading && !runtimes.some((r) => r.id === runtimeId);
  const { errors } = parseEnvOverlay(envText);

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor={`${idPrefix}-runtime`} className="text-sm text-fg-muted block mb-1">Runtime</Label>
        {!loading && runtimes.length === 0 && !missing ? (
          <p className="text-xs text-fg-subtle">
            No paired machines yet. <Link to="/runtimes" className="underline">Connect a machine</Link> first.
          </p>
        ) : (
          <Select
            id={`${idPrefix}-runtime`}
            value={runtimeId}
            onValueChange={onRuntimeIdChange}
            placeholder={loading ? "Loading runtimes…" : "Select a machine"}
          >
            {runtimes.map((r) => (
              <SelectOption key={r.id} value={r.id}>
                {r.hostname} · {r.os} · {r.status}
              </SelectOption>
            ))}
            {missing && <SelectOption value={runtimeId}>{runtimeId} (revoked or not yours)</SelectOption>}
          </Select>
        )}
        <p className="text-xs text-fg-subtle mt-1">
          To use this overlay, select an agent configured for the same Runtime.
          Attaching this environment does not yet choose where sessions run.
        </p>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-env`} className="text-sm text-fg-muted block mb-1">
          Env overlay <span className="text-fg-subtle">(optional)</span>
        </Label>
        <Textarea
          id={`${idPrefix}-env`}
          value={envText}
          onChange={(e) => onEnvTextChange(e.target.value)}
          rows={4}
          aria-invalid={errors.length > 0}
          className="w-full border border-border rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-brand bg-bg text-fg resize-y placeholder:text-fg-subtle"
          placeholder={"NODE_ENV=development\nAPI_BASE_URL=https://staging.example.com"}
        />
        {errors.length > 0 ? (
          <ul className="text-xs text-danger mt-1 space-y-0.5">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        ) : (
          <p className="text-xs text-fg-subtle mt-1">
            KEY=value per line, injected into the runner's shell, MCP servers and plugins.
            Values are visible to workspace members — keep secrets in a vault.
          </p>
        )}
      </div>
    </div>
  );
}
