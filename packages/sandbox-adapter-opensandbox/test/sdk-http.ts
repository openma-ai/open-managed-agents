import { vi } from "vitest";

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

export const completed = { type: "execution_complete", execution_time: 1 };
export const sandboxInfo = (state = "Running") => ({
  id: "sb-1", status: { state }, createdAt: "2026-10-26T08:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z", image: { uri: "node:22-slim" },
  entrypoint: ["tail", "-f", "/dev/null"], metadata: {},
});

/** Exercise the real SDK's request serialization and response parsing. */
export function mockSdkServer() {
  const server = {
    calls: [] as RecordedRequest[],
    commands: [completed] as unknown[],
    format: "sse" as "sse" | "json",
    state: "Running",
    override: undefined as ((request: RecordedRequest) => Response | undefined) | undefined,
  };
  vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const contentType = request.headers.get("content-type") ?? "";
    const body = contentType.startsWith("multipart/form-data") ? await request.clone().formData()
      : request.body ? await request.clone().json() : undefined;
    const call = { url: new URL(request.url), method: request.method, headers: request.headers, body };
    server.calls.push(call);
    const overridden = server.override?.(call);
    if (overridden) return overridden;
    const path = call.url.pathname;
    if (path.endsWith("/sandboxes") && call.method === "POST") return Response.json(sandboxInfo(server.state), { status: 202 });
    if (/\/endpoints\/\d+$/.test(path)) return Response.json({ endpoint: "exec.test:44772", headers: { "X-EXECD-ACCESS-TOKEN": "runtime-token" } });
    if (path.endsWith("/sb-1") && call.method === "GET") return Response.json(sandboxInfo(server.state));
    if (path.endsWith("/command")) {
      const text = server.commands.map(event => (server.format === "sse" ? "data: " : "") + JSON.stringify(event) + "\r\n\r\n").join("");
      const bytes = new TextEncoder().encode(text);
      return new Response(new ReadableStream({
        start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (path.endsWith("/files/download")) return new Response(Uint8Array.of(0, 255, 1));
    if (call.method === "DELETE" || path.endsWith("/files/upload")) return new Response(null, { status: 204 });
    return Response.json({});
  }));
  return server;
}
