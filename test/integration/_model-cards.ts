// There is no platform model key: every turn resolves credentials from the
// workspace's own model card. Integration files that start real turns create
// the cards their agents reference, exactly as an operator would.
import { exports } from "cloudflare:workers";

export async function ensureModelCards(
  modelIds: string[],
  headers: Record<string, string> = { "x-api-key": "test-key" },
): Promise<void> {
  for (const modelId of modelIds) {
    const response = await exports.default.fetch(new Request("http://localhost/v1/oma/model_cards", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ provider: "ant", model_id: modelId, api_key: "sk-ant-test-key" }),
    }));
    if (response.status !== 201 && response.status !== 409) {
      throw new Error(`model card ${modelId}: ${response.status} ${await response.text()}`);
    }
  }
}
