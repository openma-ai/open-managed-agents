/**
 * Runtime env overlay ⇄ dotenv-style text, for the Environment
 * "Attach to Runtime" editor. One `KEY=value` per line; blank lines and
 * `#` comments are ignored; the value is everything after the first `=`
 * (so values may contain `=`). Names follow the same rule the API
 * enforces on `_oma.runtime.env`.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ParsedEnvOverlay {
  env: Record<string, string>;
  /** Human-readable, 1-based line errors. Empty when the text is valid. */
  errors: string[];
}

export function parseEnvOverlay(text: string): ParsedEnvOverlay {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const name = (eq < 0 ? line : line.slice(0, eq)).trim();
    if (eq < 0) {
      errors.push(`Line ${index + 1}: expected KEY=value`);
    } else if (!ENV_NAME.test(name)) {
      errors.push(`Line ${index + 1}: invalid variable name "${name}"`);
    } else if (name in env) {
      errors.push(`Line ${index + 1}: duplicate variable ${name}`);
    } else {
      env[name] = line.slice(eq + 1).trim();
    }
  });
  return { env, errors };
}

/**
 * `_oma.runtime` update value for the Environment editor: `undefined` when
 * nothing changed (keeps the request plain CMA), `null` to detach, or the
 * whole replacement attachment.
 */
export function runtimeAttachmentPatch(
  stored: { runtime_id: string; placement?: "host" | "sandbox"; env: Record<string, string> } | undefined,
  runtimeId: string,
  env: Record<string, string>,
  placement: "host" | "sandbox" = "host",
): { runtime_id: string; placement: "host" | "sandbox"; env: Record<string, string> } | null | undefined {
  if (runtimeId === "") return stored === undefined ? undefined : null;
  const unchanged =
    stored?.runtime_id === runtimeId &&
    (stored.placement ?? "host") === placement &&
    formatEnvOverlay(stored.env) === formatEnvOverlay(env);
  return unchanged ? undefined : { runtime_id: runtimeId, placement, env };
}

export function formatEnvOverlay(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}
