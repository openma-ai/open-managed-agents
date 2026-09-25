import { nodeDefaults } from "@open-managed-agents/main-node/components";
import { loadNodeConfig } from "@open-managed-agents/main-node/config";
import { createNodeControlPlane } from "@open-managed-agents/main-node/control-plane";
import { serveNodeControlPlane } from "@open-managed-agents/main-node/serve";

import { prepareFlyMachineEnvironment } from "./production.js";

// Project Fly Machine metadata onto the Node configuration contract, then
// assemble and host the control plane explicitly — no side-effect import.
prepareFlyMachineEnvironment(process.env);
const config = loadNodeConfig(process.env);
const controlPlane = await createNodeControlPlane(await nodeDefaults(config));
await controlPlane.start();
await serveNodeControlPlane(controlPlane, { ...config.http, signals: {} });
