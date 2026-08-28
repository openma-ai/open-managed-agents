// @open-managed-agents/feishu
//
// Feishu-specific implementation of integrations-core's IntegrationProvider.
// Pure logic only — no Cloudflare imports, no Hono, no D1. All runtime
// concerns (HTTP, storage, crypto, JWT) are injected via integrations-core
// ports plus the Feishu-specific FeishuPublicationRepo /
// FeishuInstallationRepo / FeishuSessionScopeRepo extensions.

export {
  FeishuProvider,
  type FeishuContainer,
  FEISHU_SIGNAL_PROTOCOL_PROMPT,
  scopeKeyFor,
} from "./provider";
export {
  type FeishuConfig,
  type FeishuCapabilityKey,
  ALL_FEISHU_CAPABILITIES,
  DEFAULT_FEISHU_SCOPES,
  DEFAULT_FEISHU_SUBSCRIBED_EVENTS,
} from "./config";
export {
  validateFeishuAppCredentials,
  normalizeFeishuAppCredentials,
  type FeishuAppCredentialsInput,
  type FeishuAppCredentialsError,
} from "./oauth/credentials";
export {
  detectSigningMode,
  computeEncryptKeyChallenge,
  computeVerificationTokenChallenge,
  constantTimeEqual,
  type FeishuSigningMode,
} from "./webhook/signature";
export {
  parseWebhook,
  parseWsFrame,
  isUrlVerificationEnvelope,
  isEventCallbackEnvelope,
  type NormalizedFeishuEvent,
  type FeishuEventKind,
  type RawFeishuEnvelope,
  type RawFeishuUrlVerification,
  type RawFeishuEventCallback,
  FEISHU_PROVIDER_ID,
} from "./webhook/parse";
export {
  FeishuApiClient,
  FeishuApiError,
  type FeishuTenantAccessToken,
} from "./api/client";
export type {
  FeishuInstallationRepo,
  FeishuPublicationRepo,
  FeishuPublicationCredentialState,
  FeishuSessionScopeRepo,
} from "./ports";
