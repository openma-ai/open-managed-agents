import type { ContentBlock } from "@open-managed-agents/shared";

/**
 * Resolve a `file_id` (Anthropic Managed Agents spec: ImageBlock/DocumentBlock
 * with `source.type === "file"`) into its underlying bytes + media type +
 * filename. Implementations should return `null` when the file is missing,
 * permission-denied, or otherwise un-resolvable so the caller can emit a
 * placeholder rather than crash the turn.
 *
 * Wired through `HarnessContext.fileFetcher`; SessionDO populates it with a
 * services.files.get + R2 bucket fetch composition. Tests / sub-agents that
 * don't carry the field will leave it undefined — the sync `eventsToMessages`
 * + sync `userContentToParts` fall back to placeholder text in that case.
 */
export interface ResolvedFile {
  bytes: Uint8Array;
  mediaType: string;
  filename: string;
}
export type FileResolver = (file_id: string) => Promise<ResolvedFile | null>;

/**
 * UserMessageEvent.content → AI SDK user message content[].
 * Kept simple — image/document mapping mirrors the writer's normalizations.
 *
 * `source.type === "file"` (Anthropic Managed Agents spec: ImageBlock /
 * DocumentBlock referencing an uploaded file by id) collapses to a text
 * placeholder here because file resolution is async — callers that own a
 * resolver should use `userContentToPartsAsync` instead.
 */
export function userContentToParts(blocks: ContentBlock[]): any[] {
  return blocks.map((b): any => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "image") {
      if (b.source.type === "url" && b.source.url) {
        return { type: "image", image: new URL(b.source.url), mediaType: b.source.media_type };
      }
      if (b.source.type === "file") {
        return filePlaceholderPart("image", b.source.file_id);
      }
      return { type: "image", image: b.source.data ?? "", mediaType: b.source.media_type };
    }
    if (b.type === "document") {
      const providerOptions = documentProviderOptions(b);
      if (b.source.type === "url" && b.source.url) {
        return {
          type: "file",
          data: new URL(b.source.url),
          mediaType: b.source.media_type,
          ...(providerOptions ? { providerOptions } : {}),
        };
      }
      if (b.source.type === "text") {
        const prefix = b.title ? `[${b.title}]\n` : "";
        return { type: "text", text: prefix + (b.source.data ?? "") };
      }
      if (b.source.type === "file") {
        return filePlaceholderPart("document", b.source.file_id);
      }
      return {
        type: "file",
        data: b.source.data ?? "",
        mediaType: b.source.media_type ?? "application/pdf",
        ...(providerOptions ? { providerOptions } : {}),
      };
    }
    return { type: "text", text: JSON.stringify(b) };
  });
}

/**
 * Async counterpart to `userContentToParts`. The only divergence from the
 * sync path: ImageBlock / DocumentBlock with `source.type === "file"` are
 * resolved through `resolver` to inline bytes (AI SDK `{type:"image",image:
 * Uint8Array,...}` / `{type:"file",data:Uint8Array,...}`). On resolver
 * failure (null return) we emit the same placeholder the sync path uses so
 * the turn doesn't crash.
 */
export async function userContentToPartsAsync(
  blocks: ContentBlock[],
  resolver: FileResolver,
): Promise<any[]> {
  return Promise.all(blocks.map(async (b): Promise<any> => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "image") {
      if (b.source.type === "url" && b.source.url) {
        return { type: "image", image: new URL(b.source.url), mediaType: b.source.media_type };
      }
      if (b.source.type === "file" && b.source.file_id) {
        const resolved = await resolver(b.source.file_id);
        if (!resolved) return filePlaceholderPart("image", b.source.file_id);
        return {
          type: "image",
          image: resolved.bytes,
          mediaType: resolved.mediaType,
        };
      }
      return { type: "image", image: b.source.data ?? "", mediaType: b.source.media_type };
    }
    if (b.type === "document") {
      const providerOptions = documentProviderOptions(b);
      if (b.source.type === "url" && b.source.url) {
        return {
          type: "file",
          data: new URL(b.source.url),
          mediaType: b.source.media_type,
          ...(providerOptions ? { providerOptions } : {}),
        };
      }
      if (b.source.type === "text") {
        const prefix = b.title ? `[${b.title}]\n` : "";
        return { type: "text", text: prefix + (b.source.data ?? "") };
      }
      if (b.source.type === "file" && b.source.file_id) {
        const resolved = await resolver(b.source.file_id);
        if (!resolved) return filePlaceholderPart("document", b.source.file_id);
        return {
          type: "file",
          data: resolved.bytes,
          mediaType: resolved.mediaType,
          filename: resolved.filename,
          ...(providerOptions ? { providerOptions } : {}),
        };
      }
      return {
        type: "file",
        data: b.source.data ?? "",
        mediaType: b.source.media_type ?? "application/pdf",
        ...(providerOptions ? { providerOptions } : {}),
      };
    }
    return { type: "text", text: JSON.stringify(b) };
  }));
}

/**
 * Build the Anthropic-specific providerOptions object DocumentBlocks need
 * when they carry title / context / citations. Shared between the sync and
 * async user-content converters so the byte shape stays identical.
 */
function documentProviderOptions(
  b: Extract<ContentBlock, { type: "document" }>,
): { anthropic: Record<string, unknown> } | undefined {
  if (!(b.citations || b.title || b.context)) return undefined;
  return {
    anthropic: {
      ...(b.citations ? { citations: b.citations } : {}),
      ...(b.title ? { title: b.title } : {}),
      ...(b.context ? { context: b.context } : {}),
    },
  };
}

/**
 * Placeholder for a file-referenced block we couldn't resolve (no resolver
 * supplied, file deleted, auth fail, R2 fetch failed). Keeps the model in
 * the loop that something was attached so it can ask the user / give up
 * gracefully, rather than seeing an empty content block + thinking the user
 * sent nothing.
 */
function filePlaceholderPart(kind: "image" | "document", fileId: string | undefined): { type: "text"; text: string } {
  const id = fileId ?? "unknown";
  return { type: "text", text: `[${kind}: file ${id} unavailable]` };
}
