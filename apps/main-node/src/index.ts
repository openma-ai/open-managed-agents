// Node-side single-process entrypoint and compatibility module.
//
// The control plane itself is assembled by createNodeControlPlane() in
// ./control-plane.ts from an explicit environment. This module keeps the
// historical side-effect contract: importing it builds one control plane from
// process.env, exports its Hono `app` and `shutdownNodeApp`, and — in
// standalone mode — starts background work, listens, and handles signals.
// Deployment presets (Fly, Vercel) and tests import this module; embedders
// that need their own environment or lifecycle should call the factory.

import { serve } from "@hono/node-server";

import { loadNodeConfig } from "./config.js";
import { createNodeControlPlane } from "./control-plane.js";

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

// The only read of process.env: everything else receives typed configuration.
const config = loadNodeConfig(process.env);
const controlPlane = await createNodeControlPlane(config);
const { logger } = controlPlane;

export const app = controlPlane.app;
export const shutdownNodeApp = (signal = "dispose"): Promise<void> => controlPlane.stop(signal);

if (controlPlane.processMode === "standalone") {
  const { host, port } = config.http;
  await controlPlane.start();
  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    logger.info(
      { op: "main-node.listening", address: info.address, port: info.port, db: controlPlane.backendDescription },
      `listening on http://${info.address}:${info.port}`,
    );
  });

  const shutdownProcess = async (signal: string) => {
    await controlPlane.stop(signal);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdownProcess("SIGTERM"));
  process.on("SIGINT", () => void shutdownProcess("SIGINT"));
}
