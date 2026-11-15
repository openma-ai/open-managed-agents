import { isMcpToolEnabled, type McpToolSelectionConfig } from "@open-managed-agents/mcp";
import type { ReplayableBody } from "./forward";

type Rpc = Record<string, unknown>;
const object = (value: unknown): value is Rpc => typeof value === "object" && value !== null && !Array.isArray(value);

/** Only tool methods are inspected. Other exchanges retain their original stream. */
export function selectMcpToolRequest(body: ReplayableBody, config: McpToolSelectionConfig, server: string) {
  const enabled = (name: string) => isMcpToolEnabled(config, server, name);
  // GET replay has no request ids: treat every list-shaped result as a list.
  const replay = body === null;
  const listIds = new Set<unknown>();
  const errors: Rpc[] = [];
  let batch = false;
  let selected = body;
  let empty = false;
  try {
    const parsed: unknown = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body ?? new ArrayBuffer(0)));
    batch = Array.isArray(parsed);
    const requests = batch ? parsed as unknown[] : [parsed];
    const allowed = requests.filter(request => {
      if (!object(request)) return true;
      if (request.method === "tools/list") listIds.add(request.id);
      if (request.method !== "tools/call" || !object(request.params) || typeof request.params.name !== "string" || enabled(request.params.name)) return true;
      if ("id" in request) errors.push({ jsonrpc: "2.0", id: request.id,
        error: { code: -32601, message: "MCP tool is not enabled: " + request.params.name } });
      return false;
    });
    if (allowed.length !== requests.length) {
      selected = JSON.stringify(batch ? allowed : allowed[0]);
      empty = allowed.length === 0;
    }
  } catch {
    // Invalid JSON remains the upstream protocol handler's responsibility.
  }
  const localResponse = () => errors.length === 0
    ? new Response(null, { status: 202 })
    : Response.json(batch ? errors : errors[0]);
  const filter = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(filter);
    if (!object(value) || (!replay && !listIds.has(value.id)) || !object(value.result) || !Array.isArray(value.result.tools)) return value;
    return { ...value, result: { ...value.result,
      // Keep nextCursor even for an empty page: clients must be able to continue.
      tools: value.result.tools.filter(tool => object(tool) && typeof tool.name === "string" && enabled(tool.name)),
    } };
  };
  return {
    body: selected,
    response: empty ? localResponse() : undefined,
    async filterResponse(response: Response): Promise<Response> {
      if (errors.length > 0 && response.ok && (response.status === 202 || response.body === null)) return localResponse();
      if ((!replay && listIds.size === 0 && errors.length === 0) || !response.ok || response.body === null) return response;
      const headers = new Headers(response.headers);
      for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
      if (headers.get("content-type")?.includes("text/event-stream")) {
        // Transform one complete SSE event at a time; pipeThrough propagates
        // consumer cancellation and never waits for a long-lived stream to end.
        let pending = "";
        const transformEvent = (event: string) => {
          const lines = event.split(/\r\n|\r|\n/);
          const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (!data) return event;
          const value: unknown = JSON.parse(data);
          const filtered = filter(value);
          if (filtered === value) return event;
          const metadata = lines.filter(line => !line.startsWith("data:"));
          return [...metadata, "data: " + JSON.stringify(filtered)].join("\n");
        };
        const stream = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, string>({
          start(controller) {
            if (errors.length > 0) controller.enqueue("event: message\ndata: " + JSON.stringify(batch ? errors : errors[0]) + "\n\n");
          },
          transform(chunk, controller) {
            pending += chunk;
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending)) !== null) {
              controller.enqueue(transformEvent(pending.slice(0, boundary.index)) + "\n\n");
              pending = pending.slice(boundary.index + boundary[0].length);
            }
          },
          flush(controller) { if (pending) controller.enqueue(transformEvent(pending)); },
        })).pipeThrough(new TextEncoderStream());
        return new Response(stream, { status: response.status, statusText: response.statusText, headers });
      }
      const value: unknown = await response.json();
      const result = filter(value);
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify(errors.length === 0 ? result : [...(Array.isArray(result) ? result : [result]), ...errors]),
        { status: response.status, statusText: response.statusText, headers });
    },
  };
}
