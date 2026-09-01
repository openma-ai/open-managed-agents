import { describe, expect, it } from "vitest";
import { WebCryptoMemoryContentDescriptor } from "../src";

describe("WebCryptoMemoryContentDescriptor", () => {
  it("describes the exact UTF-8 bytes used by the Managed Memory contract", async () => {
    const descriptor = new WebCryptoMemoryContentDescriptor();

    await expect(descriptor.describe({ content: "hello" })).resolves.toEqual({
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      sizeBytes: 5,
    });
    await expect(descriptor.describe({ content: null })).resolves.toEqual({
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      sizeBytes: 0,
    });
  });
});
