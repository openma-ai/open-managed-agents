import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { TLSSocket, createSecureContext } from "node:tls";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { createEgressCertificateAuthority, loadOrCreateEgressCa } from "./ca.js";
import { sendDirectHttps } from "./direct-https.js";
export interface LocalRelayConfig { endpoint: string; pass: string; ca?: string; directory: string }
const HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
function headersOf(request: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  for (const name of (headers.get("connection") ?? "").split(",")) if (name.trim()) headers.delete(name.trim());
  for (const name of HOP) headers.delete(name);
  headers.delete("content-length"); headers.delete("host");
  return headers;
}
async function bytes(request: IncomingMessage) { const parts: Buffer[] = []; for await (const part of request) parts.push(part); return Buffer.concat(parts); }
function reject(socket: Duplex, status: number) { socket.end(`HTTP/1.1 ${status} Denied\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`); }
async function respond(response: Response, output: ServerResponse) {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => { if (!HOP.includes(name)) headers[name] = name === "set-cookie" ? response.headers.getSetCookie() : value; });
  output.writeHead(response.status, response.statusText, headers);
  if (!response.body) { output.end(); return; }
  const stream = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
  stream.once("error", () => output.destroy()); stream.pipe(output);
}
/** Runs inside one sandbox. It never receives a Vault token or root secret. */
export async function startLocalRelay(config: () => LocalRelayConfig) {
  const authority = await createEgressCertificateAuthority(await loadOrCreateEgressCa(config().directory));
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const tunnels = new WeakMap<object, { hostname: string; port: number }>();
  // Never downgrade a previously credential-bearing host to direct traffic
  // after its Vault is removed. The relay returns an explicit denial instead.
  const interceptedHosts = new Set<string>();
  const relay = async (action: "resolve" | "forward", target: string, method = "GET", headers = new Headers(), body: Buffer | null = null) => {
    const current = config();
    const endpoint = new URL(`/v1/oma/egress/${action}`, current.endpoint);
    if (endpoint.protocol !== "https:") throw new Error("Credential relay requires HTTPS");
    return sendDirectHttps(new Request(endpoint, { method: "POST", headers: {
      authorization: `Bearer ${current.pass}`, "x-oma-egress-target": target,
      "x-oma-egress-method": method, "x-oma-egress-headers": JSON.stringify(Object.fromEntries(headers)),
    }, body }), current.ca);
  };
  const intercepted = createServer(async (request, response) => {
    const target = tunnels.get(request.socket);
    if (!target) { response.writeHead(502).end(); return; }
    try {
      if (!(request.url ?? "").startsWith("/") || (request.url ?? "").startsWith("//")) throw new Error("Invalid path");
      const hostname = target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname;
      const url = `https://${hostname}:${target.port}${request.url}`;
      await respond(await relay("forward", url, request.method, headersOf(request), await bytes(request)), response);
    } catch { if (!response.headersSent) response.writeHead(502).end("Credential relay unavailable"); else response.destroy(); }
  });
  const front = createServer(async (request, response) => {
    if (request.url === "/health") { response.writeHead(200).end("ready"); return; }
    // Plain HTTP is never credential-injected.
    try {
      const url = new URL(request.url ?? ""); if (url.protocol !== "http:") throw new Error("Invalid HTTP URL");
      const upstream = httpRequest(url.toString(), { method: request.method, headers: Object.fromEntries(headersOf(request)), agent: false }, incoming => {
        const headers = { ...incoming.headers }; for (const name of HOP) delete headers[name];
        response.writeHead(incoming.statusCode ?? 502, headers); incoming.pipe(response);
      });
      upstream.once("error", () => response.writeHead(502).end()); request.pipe(upstream);
    } catch { response.writeHead(400).end(); }
  });
  front.on("connection", track);
  front.on("connect", async (request, client, head) => {
    track(client); client.once("error", () => client.destroy());
    try {
      const match = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9.-]+)):(\d{1,5})$/u.exec(request.url ?? "");
      if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) { reject(client, 400); return; }
      const hostname = (match[1] ?? match[2])!; const port = Number(match[3]);
      const resolved = await relay("resolve", `https://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}/`);
      if (!resolved.ok) { reject(client, resolved.status); return; }
      const { inject } = await resolved.json() as { inject: boolean };
      if (inject) interceptedHosts.add(hostname);
      if (!inject && !interceptedHosts.has(hostname)) {
        const upstream = connect({ host: hostname, port }); track(upstream);
        upstream.once("connect", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream); });
        upstream.once("error", () => reject(client, 502)); client.once("close", () => upstream.destroy()); return;
      }
      const secureContext = createSecureContext(await authority.leafFor(hostname));
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) client.unshift(head);
      const tls = new TLSSocket(client as Socket, { isServer: true, secureContext, ALPNProtocols: ["http/1.1"] });
      track(tls); tls.once("error", () => tls.destroy()); tunnels.set(tls, { hostname, port }); intercepted.emit("connection", tls);
    } catch { reject(client, 502); }
  });
  await new Promise<void>((resolve, reject) => { front.once("error", reject); front.listen(0, "127.0.0.1", resolve); });
  return { port: (front.address() as { port: number }).port, certificatePem: authority.certificatePem,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => front.close(() => resolve())); intercepted.close(); },
  };
}
