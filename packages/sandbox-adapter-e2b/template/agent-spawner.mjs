/** Inject into common's local ACP runtime in the trusted root worker entry.
 * Only stdio within the sandbox; no provider/control-plane transport.
 * NodeSpawner merges process.env; the root-private helper drops UID before
 * execve with a replacement env, without any shell or agent loader hooks.
 * This prevents accidental inheritance, not inspection by guest sudo/root.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export function isolateE2BAgentSpawner(nativeSpawner) {
  return {
    async spawn(spec) {
      if (process.getuid?.() !== 0) throw new Error("E2B trusted worker must be root to drop agent identity");
      const env = Object.entries(spec.env ?? {}).filter(([, value]) => value !== undefined);
      for (const [name, value] of env) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0")) throw new TypeError("Invalid agent environment");
        if (/^(ANTHROPIC_(WORK_SECRET|ENVIRONMENT_KEY)|OPENMA_SANDBOX_TOKEN|SYNTHETIC_WORK_TOKEN)$/.test(name)) throw new Error("Management credential cannot enter agent environment");
      }
      // Neither worker nor agent credentials may appear in world-readable argv.
      const directory = await mkdtemp("/run/oma-managed/agent-launch-");
      const input = join(directory, "spec.json");
      await writeFile(input, JSON.stringify({ command: spec.command, args: spec.args ?? [], env: Object.fromEntries(env) }), { mode: 0o600 });
      try {
        const child = await nativeSpawner.spawn({
          ...spec,
          command: "/usr/bin/python3",
          args: ["-I", "-S", new URL("./agent-exec.py", import.meta.url).pathname, input],
          env: {},
        });
        const cleanup = () => rm(directory, { recursive: true, force: true });
        void child.exited.then(cleanup, cleanup).catch(() => undefined);
        return child;
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
