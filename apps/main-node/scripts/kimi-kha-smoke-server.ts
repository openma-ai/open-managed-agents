/** Local-only deterministic demo for the KHA transport spike. Never calls an LLM. */
import { serve } from "@hono/node-server";
import { createKhaFixture } from "../test/helpers/kimi-kha-fixture.js";

const { app } = createKhaFixture();
const server = serve({ fetch: async (request) => {
  const response = await app.fetch(request);
  if (process.env.KHA_SMOKE_TRACE === "1") {
    const url = new URL(request.url);
    // Fixture-only receipts: never log authorization headers or request bodies.
    console.log(JSON.stringify({ method: request.method, path: url.pathname + url.search,
      status: response.status, ...(!response.ok ? { body: await response.clone().text() } : {}) }));
  }
  return response;
}, hostname: "127.0.0.1", port: Number(process.env.PORT ?? 8799) }, (info) => {
  console.log(`KHA fixture (no LLM): http://127.0.0.1:${info.port}/kha; API key: dummy`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if ("closeAllConnections" in server) server.closeAllConnections();
  server.close(() => process.exit(0));
});
