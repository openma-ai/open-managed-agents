import { DaemonConnection, type DaemonConnectionState } from "@openma/common/local-runtime";
import { decodeSessionCommand } from "@openma/common/session-kernel";
import WebSocket from "ws";

export interface CliDaemonSessions {
  setSender(sender: (message: Record<string, unknown>) => void): void;
  announceAll(): void;
  start(input: { session_id: string; agent_id: string; tenant_id?: string; resume?: { acp_session_id: string } }): Promise<void>;
  prompt(input: { session_id: string; turn_id: string; text: string; tenant_id?: string }): Promise<void>;
  cancel(sessionId: string, turnId: string): void;
  dispose(sessionId: string): Promise<void>;
}
export interface CliDaemonOptions {
  serverUrl: string;
  token: string;
  sessions: CliDaemonSessions;
  manifest(): Promise<Record<string, unknown>>;
  onState?(state: DaemonConnectionState): void;
}
export function createCliDaemonConnection(options: CliDaemonOptions): DaemonConnection {
  const url = `${options.serverUrl.replace(/^http(s?):\/\//, "ws$1://").replace(/\/$/, "")}/agents/runtime/_attach`;
  const sessions = options.sessions;
  const connection = new DaemonConnection({
    openSocket: () => new WebSocket(url, { headers: { Authorization: `Bearer ${options.token}` } }),
    async onOpen(channel) {
      if (!channel.send(await options.manifest())) return;
      // Repoint before announce: a reconnect must publish on the new socket.
      sessions.setSender((message) => { channel.send(message); });
      sessions.announceAll();
    },
    onState: options.onState,
    onMessage(message) {
      const command = decodeSessionCommand(message);
      if (!command) return;
      const tenant = typeof message.tenant_id === "string" ? { tenant_id: message.tenant_id } : {};
      const failed = () => {
        connection.send({ type: "session.error", session_id: command.sessionId, ...tenant,
          ...("turnId" in command ? { turn_id: command.turnId } : {}), message: "Runner could not handle the session command" });
      };
      // Existing SessionManager owns preparation, activity and native prompts.
      // Reconnect never creates a new manager or re-dispatches earlier input.
      try {
        switch (command.type) {
          case "session.start":
            void sessions.start({ session_id: command.sessionId, agent_id: command.agentId, ...tenant,
              ...(command.acpSessionId ? { resume: { acp_session_id: command.acpSessionId } } : {}) }).catch(failed);
            break;
          case "session.prompt":
            void sessions.prompt({ session_id: command.sessionId, turn_id: command.turnId, text: command.text, ...tenant }).catch(failed);
            break;
          case "session.cancel": sessions.cancel(command.sessionId, command.turnId); break;
          case "session.dispose": void sessions.dispose(command.sessionId).catch(failed); break;
        }
      } catch { failed(); }
    },
  });
  return connection;
}
