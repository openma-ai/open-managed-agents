import type {
  ListProviderCatalogModelsResult,
  ProviderModelCatalogSourcePort,
} from "@open-managed-agents/oma-models";

export interface HttpFetchPort {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export class HttpProviderModelCatalog implements ProviderModelCatalogSourcePort {
  constructor(private readonly dependencies: HttpFetchPort) {}

  async list(input: {
    provider: string;
    apiKey: string;
  }): Promise<ListProviderCatalogModelsResult> {
    if (input.provider !== "ant" && input.provider !== "oai") {
      return { type: "unsupported_provider" };
    }
    try {
      if (input.provider === "ant") {
        const response = await this.dependencies.fetch(
          "https://api.anthropic.com/v1/models?limit=100",
          {
            headers: {
              "x-api-key": input.apiKey,
              "anthropic-version": "2023-06-01",
            },
          },
        );
        if (!response.ok) {
          return {
            type: "upstream_error",
            message: `Anthropic API ${response.status}`,
          };
        }
        const body = await response.json() as {
          data?: Array<{ id?: unknown; display_name?: unknown }>;
        };
        const models = (body.data ?? []).flatMap((model) =>
          typeof model.id === "string"
            ? [{
                id: model.id,
                name: typeof model.display_name === "string"
                  ? model.display_name
                  : model.id,
              }]
            : []
        );
        return { type: "success", models };
      }

      const response = await this.dependencies.fetch(
        "https://api.openai.com/v1/models",
        { headers: { Authorization: `Bearer ${input.apiKey}` } },
      );
      if (!response.ok) {
        return {
          type: "upstream_error",
          message: `OpenAI API ${response.status}`,
        };
      }
      const body = await response.json() as {
        data?: Array<{ id?: unknown }>;
      };
      const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-"];
      const models = (body.data ?? [])
        .flatMap((model) => typeof model.id === "string" ? [model.id] : [])
        .filter((id) => chatPrefixes.some((prefix) => id.startsWith(prefix)))
        .sort((left, right) => left.localeCompare(right))
        .map((id) => ({ id, name: id }));
      return { type: "success", models };
    } catch (error) {
      return {
        type: "upstream_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
