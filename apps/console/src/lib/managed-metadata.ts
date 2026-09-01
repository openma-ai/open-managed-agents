/**
 * Managed Agents metadata is a string-to-string map. Product integrations
 * encode structured values as JSON strings and decode them only at the view
 * boundary. The object branch is a temporary read-compatibility shim for
 * records written by the pre-alignment OMA API; callers still receive a
 * narrow object-or-null result rather than a widened wire model.
 */
export function readManagedMetadataObject(
  metadata: Record<string, string> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = (metadata as Record<string, unknown> | null | undefined)?.[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;

  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
