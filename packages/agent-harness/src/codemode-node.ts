import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type { CodemodeTool } from "@earendil-works/pi-codemode/portable";
import type { CodemodeRuntime } from "./codemode";

/**
 * Node/Bun adapter for the same code-mode contract used by Cloudflare. The
 * upstream sandbox keeps QuickJS in a worker thread, so a CPU-heavy script
 * does not block the Node session host.
 */
export async function createNodeCodemodeRuntime(options: {
  wasmPath?: string;
  timeoutMs?: number;
  memoryLimitBytes?: number;
} = {}): Promise<CodemodeRuntime> {
  const wasm = await loadQuickJSWasm(options.wasmPath);
  return {
    createSandbox: (tools: CodemodeTool[]) => new CodemodeSandbox({
      wasm,
      tools,
      timeoutMs: options.timeoutMs,
      memoryLimitBytes: options.memoryLimitBytes,
    }),
  };
}
