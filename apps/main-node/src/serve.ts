// Compatibility path: serving lives in @open-managed-agents/control-plane-node.
// Kept so existing imports of @open-managed-agents/main-node/serve keep working.
export {
  serveNodeControlPlane,
  type NodeServer,
  type ServeNodeControlPlaneOptions,
} from "@open-managed-agents/control-plane-node";
