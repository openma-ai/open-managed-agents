// Node-side single-process entrypoint and compatibility module.
//
// The control plane itself is assembled by createNodeControlPlane() in
// ./control-plane.ts from a NodeConfig. This module keeps the historical
// side-effect contract: importing it builds one control plane from
// process.env, exports its Hono `app` and `shutdownNodeApp`, and — in
// standalone mode — starts background work, listens, and handles signals.
// Deployment presets and embedders should not import this module; they use
// the side-effect-free subpaths instead:
//   @open-managed-agents/main-node/config         loadNodeConfig
//   @open-managed-agents/main-node/control-plane  createNodeControlPlane
//   @open-managed-agents/main-node/serve          serveNodeControlPlane

import { loadNodeConfig } from "./config.js";
import { createNodeControlPlane } from "./control-plane.js";
import { serveNodeControlPlane } from "./serve.js";

export {
  loadNodeConfig,
  redactNodeConfig,
  NodeConfigError,
  type NodeConfig,
  type NodeEnvironment,
} from "./config.js";
export {
  createNodeControlPlane,
  type NodeControlPlane,
  type NodeControlPlaneApp,
  type NodeControlPlaneDeps,
} from "./control-plane.js";
export { serveNodeControlPlane, type NodeServer } from "./serve.js";

// The only read of process.env: everything else receives typed configuration.
const config = loadNodeConfig(process.env);
const controlPlane = await createNodeControlPlane(config);

export const app = controlPlane.app;
export const shutdownNodeApp = (signal = "dispose"): Promise<void> => controlPlane.stop(signal);

if (controlPlane.processMode === "standalone") {
  await controlPlane.start();
  await serveNodeControlPlane(controlPlane, { ...config.http, signals: {} });
}
