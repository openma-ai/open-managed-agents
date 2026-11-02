import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import type {
  SandboxExecutor,
  SandboxSessionOutputMountPort,
} from "@open-managed-agents/sandbox";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { MAX_SESSION_OUTPUT_FILE_BYTES, type NodeSharedSessionOutputs } from "./node-shared-session-outputs.js";

const OUTPUTS_DIR = "/mnt/session/outputs";
const MANIFEST_BEGIN = "__OPENMA_OUTPUT_MANIFEST_BEGIN__";
const MANIFEST_END = "__OPENMA_OUTPUT_MANIFEST_END__";
const MAX_OUTPUT_FILES = 10_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024 * 1024;

export interface SynchronizeNodeManagedSessionOutputs {
  workspaceId: string;
  sessionId: string;
  sandbox: SandboxExecutor;
  executionFence: SessionExecutionFence;
  runtimeGeneration?: string;
}

export interface NodeManagedSessionOutputCollectorDependencies {
  outputsRoot: string;
  isFenceActive(fence: SessionExecutionFence): Promise<boolean>;
  shared?: NodeSharedSessionOutputs;
}

function assertSafeId(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

function decodeOutputPaths(encoded: string): string[] {
  if (encoded.includes("[exit ") || encoded.includes("[error: ")) {
    throw new Error("Sandbox failed to enumerate Session outputs");
  }
  const begin = encoded.indexOf(MANIFEST_BEGIN);
  const end = encoded.indexOf(MANIFEST_END);
  if ((begin === -1) !== (end === -1) || (begin !== -1 && end <= begin)) {
    throw new Error("Sandbox returned an incomplete Session output manifest");
  }
  const value = (begin === -1 ? encoded : encoded.slice(begin + MANIFEST_BEGIN.length, end)).trim();
  if (value === "") return [];
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error("Sandbox returned an invalid Session output manifest");
  }
  return Buffer.from(value, "base64")
    .toString("utf8")
    .split("\0")
    .filter((path: string) => path !== "");
}

function logicalOutputPath(absolutePath: string): string {
  const normalized = posix.normalize(absolutePath);
  const prefix = `${OUTPUTS_DIR}/`;
  if (
    absolutePath.includes("\0")
    || normalized === OUTPUTS_DIR
    || !normalized.startsWith(prefix)
  ) {
    throw new Error(`Unsafe Session output path: ${absolutePath}`);
  }
  const logicalPath = normalized.slice(prefix.length);
  if (
    logicalPath === ""
    || logicalPath === "."
    || logicalPath === ".."
    || logicalPath.startsWith("../")
  ) {
    throw new Error(`Unsafe Session output path: ${absolutePath}`);
  }
  return logicalPath;
}

function assertInside(root: string, candidate: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (
    normalizedCandidate !== normalizedRoot
    && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new Error(`Session output escaped its durable root: ${candidate}`);
  }
}

/**
 * Promotes provider-local Session outputs into the Node host's durable output
 * surface. Provider-native durable mounts remain zero-copy. The execution
 * fence is checked before reading and immediately before publishing the staged
 * snapshot, so an orphaned runtime cannot replace the canonical outputs.
 */
export class NodeManagedSessionOutputCollector {
  constructor(
    private readonly dependencies: NodeManagedSessionOutputCollectorDependencies,
  ) {}

  async synchronize(input: SynchronizeNodeManagedSessionOutputs): Promise<void> {
    const outputMount = input.sandbox as SandboxExecutor &
      Partial<SandboxSessionOutputMountPort>;
    const capabilities = typeof outputMount.sessionOutputMountCapabilities === "function"
      ? outputMount.sessionOutputMountCapabilities()
      : null;
    if (this.dependencies.shared === undefined && capabilities?.durability === "durable") return;
    if (this.dependencies.shared === undefined && capabilities?.durability !== "best_effort") {
      throw new Error("Sandbox does not expose collectable Session outputs");
    }
    if (input.sandbox.readFileBytes === undefined) {
      throw new Error("Sandbox cannot read provider-local Session outputs");
    }
    await this.assertFence(input.executionFence);

    assertSafeId("workspace id", input.workspaceId);
    assertSafeId("session id", input.sessionId);
    // Frame stdout: VM adapters may append diagnostic stderr to a valid
    // command's combined output (for example a seccomp warning). The
    // manifest is still unambiguous, and find failure remains fatal.
    const manifestFile = `/tmp/openma-output-list-${randomUUID()}`;
    const encoded = await input.sandbox.exec(
      `if test -d ${OUTPUTS_DIR} && find ${OUTPUTS_DIR} -type f -print0 > '${manifestFile}'; then ` +
      `printf '${MANIFEST_BEGIN}'; base64 < '${manifestFile}' | tr -d '\\n'; ` +
      `printf '${MANIFEST_END}'; rm -f '${manifestFile}'; ` +
      `else rm -f '${manifestFile}'; exit 2; fi`,
    );
    const absolutePaths = decodeOutputPaths(encoded);
    if (absolutePaths.length > MAX_OUTPUT_FILES) {
      throw new Error(`Session output file limit exceeded (${MAX_OUTPUT_FILES})`);
    }

    const sharedOutputs = this.dependencies.shared;
    let totalBytes = 0;
    const seen = new Set<string>();
    const readFiles = async function* (): AsyncGenerator<readonly [string, Uint8Array]> {
      for (const absolutePath of absolutePaths) {
        const logicalPath = logicalOutputPath(absolutePath);
        if (seen.has(logicalPath)) throw new Error(`Duplicate Session output path: ${logicalPath}`);
        seen.add(logicalPath);
        const bytes = await input.sandbox.readFileBytes!(absolutePath);
        if (bytes.byteLength > MAX_SESSION_OUTPUT_FILE_BYTES && sharedOutputs !== undefined) {
          throw new Error("Session output file exceeds shared restore size limit");
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_OUTPUT_BYTES) throw new Error(`Session output byte limit exceeded (${MAX_OUTPUT_BYTES})`);
        yield [logicalPath, bytes] as const;
      }
    };
    if (sharedOutputs !== undefined) {
      // Shared mode never touches the node-local outputs root: it can be
      // read-only in the image and is not visible to other replicas anyway.
      await sharedOutputs.publish({
        workspaceId: input.workspaceId, sessionId: input.sessionId,
        fence: input.executionFence, files: readFiles(),
        ...(input.runtimeGeneration === undefined ? {} : { runtimeGeneration: input.runtimeGeneration }),
      });
      return;
    }

    const workspaceRoot = join(this.dependencies.outputsRoot, input.workspaceId);
    await mkdir(workspaceRoot, { recursive: true });
    const staging = await mkdtemp(join(workspaceRoot, `.${input.sessionId}.collect-`));
    const target = join(workspaceRoot, input.sessionId);
    const previous = join(
      workspaceRoot,
      `.${input.sessionId}.previous-${input.executionFence.attemptId}`,
    );

    try {
      for await (const [logicalPath, bytes] of readFiles()) {
        const destination = join(staging, logicalPath);
        assertInside(staging, destination);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
      }

      await this.assertFence(input.executionFence);
      await rm(previous, { recursive: true, force: true });
      let movedPrevious = false;
      try {
        await rename(target, previous);
        movedPrevious = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await rename(staging, target);
      } catch (error) {
        if (movedPrevious) await rename(previous, target).catch(() => undefined);
        throw error;
      }
      if (movedPrevious) await rm(previous, { recursive: true, force: true });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async assertFence(fence: SessionExecutionFence): Promise<void> {
    if (!await this.dependencies.isFenceActive(fence)) {
      throw new Error("Managed Session output synchronization lost the execution fence");
    }
  }
}
