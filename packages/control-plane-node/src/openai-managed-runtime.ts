import type { EnvironmentsApplicationPort } from "@open-managed-agents/managed-agents-application/ports/environments";
import type { SessionsApplicationPort, SessionView } from "@open-managed-agents/managed-agents-application/ports/sessions";
import { OpenAIAgentsProtocolError } from "@open-managed-agents/openai-agents-api";
import { createSandboxOptionalSessionMapping, isManagedNoEnvironmentSession, type ManagedSessionMappingRuntime, type ResourceObject, type ResourceRuntimeFiles, type ResourceSecretSealer } from "@open-managed-agents/openai-agents-compat";
import type { SandboxPort } from "@open-managed-agents/sandbox";
import { isNoEnvironmentSandbox } from "./openai-no-environment";

export interface NodeOpenAIAgentsRuntimeDependencies {
  environments: EnvironmentsApplicationPort;
  sessions: Pick<SessionsApplicationPort, "retrieveSession">;
  secrets: ResourceSecretSealer;
  /** The caller binds the existing runner lookup to its authenticated workspace. */
  connectedSandbox(sessionId: string): SandboxPort | null;
}

const unsupported = (param: string): never => { throw new OpenAIAgentsProtocolError(501, `The configured Node runtime cannot enact ${param}`, param, "unsupported_feature"); };
const environmentId = (session: SessionView): string => `oai_env_${session.id}`;
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Adapts native environment selection and live SandboxPort operations. It owns
 * no session, environment-connection, or filesystem state. */
export function createNodeOpenAIAgentsRuntime(deps: NodeOpenAIAgentsRuntimeDependencies): { mapping: ManagedSessionMappingRuntime; files: ResourceRuntimeFiles } {
  const mapping = createSandboxOptionalSessionMapping(deps.environments, { dynamicSubagents: true });
  async function findSession(id: string): Promise<SessionView | null> {
    if (!id.startsWith("oai_env_") || id.length <= 8) return null;
    const found = await deps.sessions.retrieveSession({ sessionId: id.slice(8) });
    if (found.type !== "found" || found.session.archivedAt !== null || await isManagedNoEnvironmentSession(found.session, deps.secrets)) return null;
    return found.session;
  }
  async function connected(id: string): Promise<SandboxPort> {
    const session = await findSession(id);
    if (!session) throw new OpenAIAgentsProtocolError(404, "Execution environment not found");
    const sandbox = deps.connectedSandbox(session.id);
    if (!sandbox || isNoEnvironmentSandbox(sandbox)) throw new OpenAIAgentsProtocolError(409, "Execution environment is not connected");
    return sandbox;
  }
  function directory(path = "/workspace"): string {
    const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
    if ((normalized !== "/workspace" && !normalized.startsWith("/workspace/")) || normalized.includes("\0") || normalized.split("/").some(part => part === ".." || part === ".")) {
      throw new OpenAIAgentsProtocolError(400, "Path must be inside /workspace", "path");
    }
    return normalized === "/workspace" ? "." : `.${normalized.slice("/workspace".length)}`;
  }
  const files: ResourceRuntimeFiles = {
    async getEnvironment(id) {
      const session = await findSession(id);
      if (!session) return null;
      const live = deps.connectedSandbox(session.id);
      const status = live && !isNoEnvironmentSandbox(live) ? "connected" : session.status === "running" || session.status === "rescheduling" ? "pending" : "disconnected";
      return { id, object: "agent.environment", type: "openai_hosted", status, files: [], plugins: [], skills: [] };
    },
    async writeFile(id, path, content) {
      directory(path);
      const sandbox = await connected(id);
      if (!sandbox.writeFileBytes) unsupported("environment.files.binary_write");
      await sandbox.writeFileBytes!(path, content);
    },
    async listFiles(id, path) {
      const relative = directory(path);
      const sandbox = await connected(id);
      if (!sandbox.setEnvVars) unsupported("environment.files.workspace_path");
      // LocalSubprocess translates logical workspace env values; remote
      // providers retain /workspace. No provider-specific host path is exposed.
      await sandbox.setEnvVars!({ OMA_OPENAI_WORKSPACE_DIR: "/workspace" });
      const enumerate = 'for file do size=$(wc -c < "$file") || exit; printf "%s\\0%s\\0" "$file" "$size"; done';
      const command = `cd "$OMA_OPENAI_WORKSPACE_DIR" && test -d ${shellQuote(relative)} && find ${shellQuote(relative)} -type f -exec sh -c ${shellQuote(enumerate)} sh {} + | base64`;
      const encoded = (await sandbox.exec(command)).replace(/\s/g, "");
      if (encoded.length > 16_777_216 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new OpenAIAgentsProtocolError(502, "Execution environment could not enumerate files");
      const fields = Buffer.from(encoded, "base64").toString("utf8").split("\0");
      if (fields.pop() !== "" || fields.length % 2 !== 0) throw new OpenAIAgentsProtocolError(502, "Execution environment returned invalid file metadata");
      const entries: Array<{ path: string; size_bytes: number }> = [];
      for (let index = 0; index < fields.length; index += 2) {
        const relativePath = fields[index]!, size = Number(fields[index + 1]!.trim());
        if (!relativePath.startsWith("./") || !Number.isSafeInteger(size) || size < 0) throw new OpenAIAgentsProtocolError(502, "Execution environment returned invalid file metadata");
        const logical = `/workspace/${relativePath.slice(2)}`;
        directory(logical);
        entries.push({ path: logical, size_bytes: size });
      }
      return entries;
    },
  };
  return { mapping, files };
}
