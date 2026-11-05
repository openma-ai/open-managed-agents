const PROTECTED_OVERLAY_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "SHELL", "TERM", "TMPDIR", "TMP", "TEMP",
  "CLAUDE_CONFIG_DIR", "OPENMA_SKILLS_DIR",
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT",
]);

/** Multica-style matching: overlays cannot replace host/daemon-owned keys. */
export function isProtectedOverlayEnvKey(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith("OMA_") || PROTECTED_OVERLAY_ENV_KEYS.has(upper);
}

/** Apply only user overlay values; trusted agent defaults and task env bypass this filter.
 * Bundles already order Environment then session resources (session wins).
 * Leaving protected keys absent preserves inheritance; spawn-time scrubbing still applies.
 */
export function applyOverlayEnv(
  target: Record<string, string | undefined>,
  overlay: Record<string, string>,
  { warn = (key: string) => {
    process.stderr.write(`  ! custom_env: blocked key skipped key=${JSON.stringify(key)}\n`);
  } }: { warn?: (key: string) => void } = {},
): Record<string, string | undefined> {
  for (const [name, value] of Object.entries(overlay)) {
    if (isProtectedOverlayEnvKey(name)) {
      warn(name);
      continue;
    }
    target[name] = value;
  }
  return target;
}
