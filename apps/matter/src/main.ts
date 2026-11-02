/**
 * Entry point: `pnpm --filter @open-managed-agents/matter start`.
 * See README.md for the environment variables, and "Deployment Loops" for an
 * entry point that adds a deployment's own Loops.
 */

import { runMatter } from "./run.js";

void runMatter();
