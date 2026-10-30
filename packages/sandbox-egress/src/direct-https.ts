import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
/** Explicit direct transport: does not consult HTTP(S)_PROXY or Node env-proxy settings. */
export async function sendDirectHttps(input: Request, ca?: string): Promise<Response> {
  const body = ["GET", "HEAD"].includes(input.method) ? null : Buffer.from(await input.arrayBuffer());
  const headers = Object.fromEntries(input.headers);
  delete headers.host; delete headers["content-length"];
  if (body !== null) headers["content-length"] = String(body.length);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(input.url, { method: input.method, headers, agent: false, ...(ca === undefined ? {} : { ca }) }, response => {
      const headers = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
      const status = response.statusCode ?? 502;
      const empty = input.method === "HEAD" || [204, 205, 304].includes(status);
      if (empty) response.resume();
      resolve(new Response(empty ? null : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>, { status, statusText: response.statusMessage, headers }));
    });
    request.once("error", reject); request.end(body);
  });
}
