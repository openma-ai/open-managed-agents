import { describe, expect, it, vi } from "vitest";
import { contextImages, MAX_TURN_IMAGES, withImages } from "../src/images.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const context = (images: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    scopeId: "s",
    items: [
      { id: "i0", kind: "instructions", value: "reply in the thread" },
      {
        id: "e1",
        kind: "event",
        value: { id: "evt", source: { authority: "cli_app" }, payload: { messageId: "om_1", images, ...extra } },
      },
    ],
  });

describe("withImages", () => {
  it("leaves content without images untouched", async () => {
    const load = vi.fn();
    const content = context([]);
    expect(await withImages(content, load)).toBe(content);
    expect(await withImages("plain text", load)).toBe("plain text");
    expect(load).not.toHaveBeenCalled();
  });

  it("appends each image as a base64 block after the context", async () => {
    const content = context([{ id: "img_1" }, { id: "img_2", mimeType: "image/jpeg" }]);
    const load = vi.fn(async (_event: Record<string, unknown>, image: { id: string }) => ({
      bytes: PNG,
      contentType: image.id === "img_1" ? "image/png" : "image/jpeg; charset=binary",
    }));
    const out = await withImages(content, load);
    expect(out).toEqual([
      { type: "text", text: content },
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(PNG).toString("base64") } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(PNG).toString("base64") } },
    ]);
    // The loader gets the event (for the message id and authority) and the image.
    expect(load.mock.calls[0]?.[0]).toMatchObject({ payload: { messageId: "om_1" } });
    expect(load.mock.calls[1]?.[1]).toEqual({ id: "img_2", mimeType: "image/jpeg" });
  });

  it("notes images it could not show: failed, unreadable formats, over the cap", async () => {
    const ids = Array.from({ length: MAX_TURN_IMAGES + 2 }, (_, i) => ({ id: `img_${i}` }));
    const load = vi.fn(async (_event: Record<string, unknown>, image: { id: string }) => {
      if (image.id === "img_0") throw new Error("403");
      if (image.id === "img_1") return { bytes: PNG, contentType: "image/tiff" };
      return { bytes: PNG, contentType: "image/png" };
    });
    const out = (await withImages(context(ids), load)) as { type: string; text?: string }[];
    expect(load).toHaveBeenCalledTimes(MAX_TURN_IMAGES);
    expect(out.filter((b) => b.type === "image")).toHaveLength(MAX_TURN_IMAGES - 2);
    expect(out.at(-1)).toEqual({ type: "text", text: "(4 image(s) on the message could not be shown.)" });
  });

  it("reads only well-formed images of event items", () => {
    expect(contextImages(context([{ id: "" }, { nope: 1 }, "x", { id: "ok", name: "a.png" }]))).toEqual([
      expect.objectContaining({ image: { id: "ok", name: "a.png" } }),
    ]);
    expect(contextImages("{not json")).toEqual([]);
  });
});
