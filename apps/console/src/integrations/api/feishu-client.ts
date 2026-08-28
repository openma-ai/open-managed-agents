// Feishu sub-client. Extracted from client.ts so its coverage threshold
// doesn't get diluted by Slack/GitHub/Linear code that lives alongside it.
//
// Mirror of SlackClient. Feishu has no OAuth and no handoff-link — submit
// credentials finishes the install in one shot, so the surface is smaller.

import { request } from "./request";
import type {
  A1FormStep,
  A1InstallLink,
  FeishuInstallation,
  FeishuPublication,
  FeishuSessionGranularity,
  FeishuSubmitCredentialsInput,
  PublishWizardInput,
} from "./types";

export class FeishuClient {
  constructor(private readonly basePath: string) {}

  async listInstallations(): Promise<FeishuInstallation[]> {
    const r = await request<{ data: FeishuInstallation[] }>(
      this.basePath,
      "/v1/integrations/feishu/installations",
    );
    return r.data;
  }

  async listPublications(installationId: string): Promise<FeishuPublication[]> {
    const r = await request<{ data: FeishuPublication[] }>(
      this.basePath,
      `/v1/integrations/feishu/installations/${encodeURIComponent(installationId)}/publications`,
    );
    return r.data;
  }

  async listAgentPublications(agentId: string): Promise<FeishuPublication[]> {
    const r = await request<{ data: FeishuPublication[] }>(
      this.basePath,
      `/v1/integrations/feishu/agents/${encodeURIComponent(agentId)}/publications`,
    );
    return r.data;
  }

  async listPendingPublications(): Promise<FeishuPublication[]> {
    const r = await request<{ data: FeishuPublication[] }>(
      this.basePath,
      "/v1/integrations/feishu/publications?status=pending",
    );
    return r.data;
  }

  async reissueFormToken(publicationId: string): Promise<A1FormStep> {
    return request<A1FormStep>(
      this.basePath,
      `/v1/integrations/feishu/publications/${encodeURIComponent(publicationId)}/form-token`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  async getPublication(id: string): Promise<FeishuPublication> {
    return request<FeishuPublication>(
      this.basePath,
      `/v1/integrations/feishu/publications/${encodeURIComponent(id)}`,
    );
  }

  async updatePublication(
    id: string,
    patch: {
      persona?: Partial<{ name: string; avatarUrl: string | null }>;
      capabilities?: string[];
      session_granularity?: FeishuSessionGranularity;
    },
  ): Promise<FeishuPublication> {
    return request<FeishuPublication>(
      this.basePath,
      `/v1/integrations/feishu/publications/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  }

  async unpublish(id: string): Promise<void> {
    await request(
      this.basePath,
      `/v1/integrations/feishu/publications/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  async startA1(input: PublishWizardInput): Promise<A1FormStep> {
    return request<A1FormStep>(this.basePath, "/v1/integrations/feishu/start-a1", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async submitCredentials(input: FeishuSubmitCredentialsInput): Promise<A1InstallLink> {
    return request<A1InstallLink>(this.basePath, "/v1/integrations/feishu/credentials", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
}

export type { FeishuSubmitCredentialsInput, FeishuSessionGranularity };