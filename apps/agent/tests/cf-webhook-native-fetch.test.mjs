import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler/package.json"))("miniflare");
const root = fileURLToPath(new URL("../../../", import.meta.url));

test("default webhook sender uses native workerd fetch with its required receiver", async () => {
  const result = await build({
    stdin: {
      contents: "import { StandardWebhookEnvironmentWorkWakeup } from \"./packages/managed-agents-adapters-runtime/src/environment-work-webhook-wakeup.ts\";\nexport default { async fetch() {\n  const wakeup = new StandardWebhookEnvironmentWorkWakeup({\n    endpoint: \"https://webhook.test/work\", signingKey: \"whsec_\" + btoa(\"native-workerd-key\"),\n    organizationId: \"default\", nextEventId: () => \"evt_native\", maxAttempts: 1,\n  });\n  await wakeup.notifyRunStarted({workspaceId: \"default\", environmentId: \"env_native\", sessionId: \"session_native\", workId: \"work_native\", occurredAt: new Date().toISOString()});\n  return new Response(\"delivered\");\n}};",
      resolveDir: root,
      sourcefile: "native-webhook-fixture.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const deliveries = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "fixture",
    modules: true,
    script: result.outputFiles[0].text,
    compatibilityDate: "2026-04-01",
    outboundService: async (request) => {
      deliveries.push({ url: request.url, headers: request.headers, body: await request.json() });
      return new Response(null, { status: 200 });
    },
  }] }));
  try {
    const response = await mf.dispatchFetch("http://fixture.test/");
    assert.equal(await response.text(), "delivered");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].url, "https://webhook.test/work");
    assert.match(deliveries[0].headers.get("webhook-signature"), /^v1,/);
    assert.equal(deliveries[0].body.data.id, "session_native");
  } finally {
    await mf.dispose();
  }
});
