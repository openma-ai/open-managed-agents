/**
 * Starts the Matter service. `main.ts` calls it with nothing; a deployment
 * that adds its own Loops calls it from its own entry point:
 *
 *   import { runMatter } from "./run.js";
 *   import { loops } from "./deployment-loops/index.js";
 *   void runMatter({ loopTemplates: loops });
 */

import { LoopConfigError, registerLoopTemplates, type LoopTemplateEntry } from "./loops.js";
export type { LoopTemplateEntry } from "./loops.js";
import { createMatterService, listen, loadMatterConfig, MatterConfigError } from "./server.js";

export interface RunMatterOptions {
  /** The deployment's own Loop templates, next to the built-in ones. */
  readonly loopTemplates?: readonly LoopTemplateEntry[];
}

export const runMatter = async (options: RunMatterOptions = {}): Promise<void> => {
  let config;
  try {
    config = loadMatterConfig(process.env);
    if (options.loopTemplates !== undefined) registerLoopTemplates(options.loopTemplates);
  } catch (error) {
    if (error instanceof MatterConfigError || error instanceof LoopConfigError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
  const service = await createMatterService(config);
  await service.start();
  const server = await listen(service, config);
  console.log(
    `[matter] listening on ${config.host}:${config.port}; ${service.host.running().length} connection(s) running`,
  );
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[matter] ${signal}: shutting down`);
    server.close();
    void service.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};
