/**
 * Build the smallest provider capability-probe endpoint.
 *
 * Compatible providers commonly document a base URL that already ends in
 * `/v1`; appending the API version again would probe `/v1/v1/...` and report
 * a false failure. Keep the caller's path intact and add `/v1` only when it
 * is not already present.
 */
export function modelCardProbeUrl(
  provider: string,
  baseUrl: string | null | undefined,
): string {
  const normalizedProvider = provider.toLowerCase();
  const isAnt = /^(ant|anthropic|ant-compatible)$/.test(normalizedProvider);
  const isOai = /^(oai|openai|oai-compatible)$/.test(normalizedProvider);
  if (!isAnt && !isOai) {
    throw new Error(`Unsupported model-card provider: ${provider}`);
  }

  const base = (
    baseUrl ?? (isAnt ? "https://api.anthropic.com" : "https://api.openai.com")
  ).replace(/\/+$/, "");
  const versionedBase = /\/v1$/i.test(base) ? base : `${base}/v1`;
  return `${versionedBase}${isAnt ? "/messages" : "/chat/completions"}`;
}
