import type Anthropic from "@anthropic-ai/sdk";

export type OmaModelProvider = "ant" | "oai";

export interface OmaProviderModel {
  id: string;
  name: string;
}

export interface OmaModelListParams {
  provider: OmaModelProvider;
  apiKey: string;
}

export interface OmaModelListResponse {
  data: OmaProviderModel[];
}

export type OmaPath = `/v1/oma/${string}`;
export type OmaHTTPMethod = "get" | "post" | "put" | "patch" | "delete";

export interface OmaRequestParams
  extends Omit<Anthropic.RequestOptions, "method" | "path"> {
  method: OmaHTTPMethod;
  path: OmaPath;
}

export class OmaModelsResource {
  constructor(private readonly client: Anthropic) {}

  list(
    params: OmaModelListParams,
    options?: Anthropic.RequestOptions,
  ) {
    return this.client.post<OmaModelListResponse>("/v1/oma/models/list", {
      body: {
        provider: params.provider,
        api_key: params.apiKey,
      },
      ...options,
    });
  }
}

export class OmaResources {
  readonly models: OmaModelsResource;

  constructor(private readonly client: Anthropic) {
    this.models = new OmaModelsResource(client);
  }

  request<Response>(params: OmaRequestParams) {
    const { method, path, ...options } = params;
    if (!path.startsWith("/v1/oma/")) {
      throw new TypeError("OpenMA extension requests must use /v1/oma/* paths");
    }
    return this.client.request<Response>({ method, path, ...options });
  }
}
