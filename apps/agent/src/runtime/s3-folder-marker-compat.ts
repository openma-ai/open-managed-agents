/**
 * s3fs with compat_dir probes a prefix root using the legacy
 * `<prefix>_$folder$` object name. The Sandbox SDK's prefix policy quite
 * correctly rejects that key as outside the mounted prefix, but s3fs treats
 * the probe's 403 as a mount failure. Returning the normal missing-object
 * response keeps the probe harmless and lets the mount continue.
 */
export function missingS3fsFolderMarker(request: Request, props: unknown): Response | null {
  if (request.method.toUpperCase() !== "HEAD") return null;
  const value = props as { source?: { bucket?: unknown }; keyPrefix?: unknown };
  const bucket = typeof value.source?.bucket === "string" ? value.source.bucket : null;
  if (bucket === null) return null;
  const url = new URL(request.url);
  const slash = url.pathname.indexOf("/", 1);
  if (slash < 0) return null;
  let requestBucket: string;
  let key: string;
  try {
    requestBucket = decodeURIComponent(url.pathname.slice(1, slash));
    key = decodeURIComponent(url.pathname.slice(slash + 1));
  } catch {
    return null;
  }
  if (requestBucket !== bucket) return null;
  const prefix = typeof value.keyPrefix === "string" ? value.keyPrefix.replace(/\/+$/, "") : "";
  const marker = `${prefix ? `${prefix}_` : "_"}$folder$`;
  return key === marker ? new Response(null, { status: 404 }) : null;
}
