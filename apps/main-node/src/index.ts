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

import { createNodeControlPlane } from "./control-plane.js";

export {
  createNodeControlPlane,
  type NodeControlPlane,
  type NodeControlPlaneApp,
  type NodeEnvironment,
} from "./control-plane.js";

const controlPlane = await createNodeControlPlane(process.env);
const { logger } = controlPlane;

export const app = controlPlane.app;
export const shutdownNodeApp = (signal = "dispose"): Promise<void> => controlPlane.stop(signal);

if (controlPlane.processMode === "standalone") {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "0.0.0.0";
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
