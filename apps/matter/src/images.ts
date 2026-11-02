/**
 * Images on chat messages, for the Agent to see. OpenMatter puts the images
 * of a message on its event (`payload.images`, provider resource ids); the
 * Agent's Turn content is the projected context as JSON. Before the Turn's
 * message is sent, each image of an event in the context is downloaded with
 * the connection's credentials and appended as an image block.
 */

import type { AgentContent, AgentContentBlock } from "@openma/common/agent-contract";

/** One image as OpenMatter carries it (`MessageImage`). */
export interface EventImage {
  readonly id: string;
  readonly mimeType?: string;
  readonly name?: string;
}

/** Downloads one image of an event; undefined when it cannot. */
export type ImageLoader = (
  event: Record<string, unknown>,
  image: EventImage,
) => Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | undefined>;

/** Formats the model accepts. */
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** At most this many images per Turn. */
export const MAX_TURN_IMAGES = 5;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The images of the events in a projected context. */
export const contextImages = (
  content: AgentContent,
): { readonly event: Record<string, unknown>; readonly image: EventImage }[] => {
  if (typeof content !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const items = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
  const found: { event: Record<string, unknown>; image: EventImage }[] = [];
  for (const item of items) {
    if (!isRecord(item) || item.kind !== "event" || !isRecord(item.value)) continue;
    const event = item.value;
    const payload = isRecord(event.payload) ? event.payload : {};
    for (const image of Array.isArray(payload.images) ? payload.images : []) {
      if (isRecord(image) && typeof image.id === "string" && image.id.length > 0) {
        found.push({
          event,
          image: {
            id: image.id,
            ...(typeof image.mimeType === "string" ? { mimeType: image.mimeType } : {}),
            ...(typeof image.name === "string" ? { name: image.name } : {}),
          },
        });
      }
    }
  }
  return found;
};

/**
 * The Turn content with the context's images appended. Images that cannot be
 * downloaded, are not a format the model reads, or exceed the per-Turn cap
 * are left out, with a note, so the Agent knows they exist.
 */
export const withImages = async (content: AgentContent, load: ImageLoader): Promise<AgentContent> => {
  const images = contextImages(content);
  if (images.length === 0) return content;
  const blocks: AgentContentBlock[] = [];
  let skipped = 0;
  for (const [index, { event, image }] of images.entries()) {
    if (index >= MAX_TURN_IMAGES) {
      skipped += 1;
      continue;
    }
    const loaded = await load(event, image).catch(() => undefined);
    const type = loaded?.contentType.split(";")[0]?.trim().toLowerCase();
    if (loaded === undefined || type === undefined || !ACCEPTED.has(type)) {
      skipped += 1;
      continue;
    }
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: type, data: Buffer.from(loaded.bytes).toString("base64") },
    });
  }
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const note =
    skipped === 0
      ? []
      : [{ type: "text", text: `(${skipped} image(s) on the message could not be shown.)` } as AgentContentBlock];
  return [{ type: "text", text }, ...blocks, ...note];
};
