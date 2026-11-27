import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// `oma sessions chat` must not report success for a turn that did not finish.
// A local fake Managed Agents server plays the event stream; the CLI runs as a
// real child process so the exit code is observed end to end.

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const servers: ReturnType<typeof createServer>[] = [];
const streams: ServerResponse[] = [];

const frame = (event: Record<string, unknown>) =>
  `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
const at = (second: number) => `2026-11-25T00:00:0${second}.000Z`;

/** Serve one chat turn: after the user.message POST, `emit` writes the stream. */
async function chatServer(emit: (stream: ServerResponse) => void): Promise<string> {
  let stream: ServerResponse | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/sessions/session_123/events/stream") {
      stream = response;
      streams.push(response);
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.flushHeaders();
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/sessions/session_123/events") {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          data: [{ id: "event_user_01", type: "user.message", content: [{ type: "text", text: "hi" }], processed_at: null }],
        }));
        if (stream) emit(stream);
      });
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "wrong route" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

/** Run `oma sessions chat` and resolve with its exit code; kill after `timeoutMs`. */
function chat(baseURL: string, timeoutMs = 8_000) {
  return new Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, "sessions", "chat", "session_123", "hi"], {
      env: { ...process.env, OMA_BASE_URL: baseURL, OMA_API_KEY: "cli-contract-key" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr });
    });
  });
}

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.destroy();
  await Promise.all(servers.splice(0).map((server) => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }));
});

describe("oma sessions chat exit status", () => {
  it("exits 0 when the turn ends with end_turn", async () => {
    const baseURL = await chatServer((stream) => {
      stream.write(frame({ id: "event_agent_01", type: "agent.message", content: [{ type: "text", text: "REPLY_OK" }], processed_at: at(1) }));
      stream.write(frame({ id: "event_idle_01", type: "session.status_idle", stop_reason: { type: "end_turn" }, processed_at: at(2) }));
    });

    const result = await chat(baseURL);

    expect(result).toMatchObject({ code: 0, timedOut: false, stdout: "REPLY_OK\n", stderr: "" });
  });

  it("exits 3 and lists the pending event ids when the session stops on requires_action", async () => {
    const baseURL = await chatServer((stream) => {
      stream.write(frame({ id: "event_tool_01", type: "agent.tool_use", name: "bash", input: { command: "ls" }, processed_at: at(1) }));
      stream.write(frame({
        id: "event_idle_01",
        type: "session.status_idle",
        stop_reason: { type: "requires_action", event_ids: ["event_tool_01"] },
        processed_at: at(2),
      }));
      // The live session stream stays open while the session is parked.
    });

    const result = await chat(baseURL);

    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("waiting on 1 pending action: event_tool_01");
    expect(result.stderr).toContain("user.tool_confirmation");
  });

  it("exits 1 and prints the message when the server sends an error frame", async () => {
    const baseURL = await chatServer((stream) => {
      stream.end(`event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "Application session event stream failed: boom" },
      })}\n\n`);
    });

    const result = await chat(baseURL);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("stream error: Application session event stream failed: boom");
  });

  it("exits 1 with a warning when the stream closes before the session goes idle", async () => {
    const baseURL = await chatServer((stream) => {
      stream.write(frame({ type: "event_start", event: { id: "event_agent_01", type: "agent.message" } }));
      stream.end(frame({
        type: "event_delta",
        event_id: "event_agent_01",
        delta: { type: "content_delta", content: { type: "text", text: "PARTIAL" }, index: 0 },
      }));
    });

    const result = await chat(baseURL);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("PARTIAL\n");
    expect(result.stderr).toContain("event stream closed before the turn finished");
  });

  it("exits 1 instead of hanging when the session is terminated", async () => {
    const baseURL = await chatServer((stream) => {
      // Stream intentionally left open after the terminal status.
      stream.write(frame({ id: "event_term_01", type: "session.status_terminated", processed_at: at(1) }));
    });

    const result = await chat(baseURL, 5_000);

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("session terminated before the turn finished");
  });

  it("exits 1 when the turn stops on retries_exhausted", async () => {
    const baseURL = await chatServer((stream) => {
      stream.write(frame({
        id: "event_idle_01",
        type: "session.status_idle",
        stop_reason: { type: "retries_exhausted" },
        processed_at: at(1),
      }));
    });

    const result = await chat(baseURL);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("turn stopped: retries_exhausted");
  });
});
