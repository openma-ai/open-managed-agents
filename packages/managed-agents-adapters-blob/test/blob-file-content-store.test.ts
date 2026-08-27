import { describe, expect, it } from "vitest";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store";
import { BlobFileContentStore } from "../src";

describe("BlobFileContentStore", () => {
  it("isolates binary content by workspace and supports idempotent deletion", async () => {
    const blobs = new InMemoryBlobStore();
    const content = new BlobFileContentStore(blobs);

    await content.put({
      workspaceId: "workspace/one",
      fileId: "file_01",
      content: new Uint8Array([1, 2, 3]),
    });

    await expect(
      content.get({ workspaceId: "workspace/one", fileId: "file_01" }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(
      content.get({ workspaceId: "workspace_other", fileId: "file_01" }),
    ).resolves.toBeNull();
    await content.delete({ workspaceId: "workspace/one", fileId: "file_01" });
    await content.delete({ workspaceId: "workspace/one", fileId: "file_01" });
    await expect(
      content.get({ workspaceId: "workspace/one", fileId: "file_01" }),
    ).resolves.toBeNull();
  });
});
