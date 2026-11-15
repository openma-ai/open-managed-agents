/** Installed package is the default test subject. Source loading is optional
 * explicit comparison, never an implicit fallback or a reason to skip tests. */
export async function workRuntimeModules() {
  const candidate = process.env.OPENMA_COMMON_CANDIDATE;
  if (candidate) {
    const common = await import(/* @vite-ignore */ candidate + "/src/managed-runtime/index.ts");
    const modes = await import(/* @vite-ignore */ candidate + "/src/acp-runtime/permission-mapping.ts");
    const acp = await import(/* @vite-ignore */ candidate + "/src/acp-runtime/runtime.ts");
    return { common, modes, AcpRuntimeImpl: acp.AcpRuntimeImpl };
  }
  const common = await import("@openma/common/managed-runtime");
  const acp = await import("@openma/common/acp-runtime");
  return { common, modes: acp, AcpRuntimeImpl: acp.AcpRuntimeImpl };
}
