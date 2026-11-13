/** Resolve the executor's effective identity, never the SDK's root default or
 * an image-specific numeric assumption. Management commands opt into root
 * separately; this probe deliberately uses the ordinary tool identity. */
export async function executionIdentity(runtime: {
  run(command: string, options: { sessionEnv: false }): Promise<{ exitCode: number; stdout: string }>;
}): Promise<{ uid: string; gid: string }> {
  const result = await runtime.run("id -u; id -g", { sessionEnv: false });
  const parts = result.stdout.trim().split(/\s+/u);
  if (result.exitCode !== 0 || parts.length !== 2 || parts.some(value => !/^\d+$/u.test(value))) {
    throw new Error("Cannot resolve sandbox execution UID/GID");
  }
  return { uid: parts[0]!, gid: parts[1]! };
}
