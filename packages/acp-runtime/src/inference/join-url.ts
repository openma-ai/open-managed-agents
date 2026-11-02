export function joinHostedInferenceUrl(
  proxyBaseUrl: string,
  proxyPathSegment: string,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const segment = proxyPathSegment.replace(/^\//, "");
  return segment.length === 0 ? base : `${base}/${segment}`;
}
