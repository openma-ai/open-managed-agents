/**
 * Public Node control-plane entry point. The implementation is split by
 * concern under ./modules; importing this file never listens or starts work.
 */
export {
  assembleNodeControlPlane as createNodeControlPlane,
  type NodeControlPlane,
  type NodeControlPlaneApp,
} from "./modules/node-assembly.js";
export type { NodeEnvironment } from "./config.js";
