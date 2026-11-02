import { joinHostedInferenceUrl } from "@open-managed-agents/acp-runtime/inference-config";
import type { HostedInferenceProxyTarget } from "@open-managed-agents/acp-runtime/inference-config";

export function proxyUrl(
  proxy: HostedInferenceProxyTarget,
  proxyPathSegment: string,
): string {
  return joinHostedInferenceUrl(proxy.proxyBaseUrl, proxyPathSegment);
}

/** Assert config file bodies never embed the live proxy token. */
export function assertNoSecretInFileContent(
  content: string,
  secret: string,
): void {
  if (secret.length > 0 && content.includes(secret)) {
    throw new Error("config file must not contain the proxy token value");
  }
}
