// Compatibility path: the control plane lives in
// @open-managed-agents/control-plane-node. Kept so existing imports of
// @open-managed-agents/main-node/control-plane keep working.
export {
  createNodeControlPlane,
  type NodeControlPlane,
  type NodeControlPlaneApp,
  type NodeEnvironment,
} from "@open-managed-agents/control-plane-node";
