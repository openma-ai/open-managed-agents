import { describe, expect, it } from "vitest";

import { readManagedMetadataObject } from "./managed-metadata";

describe("readManagedMetadataObject", () => {
  it("decodes a JSON object stored in the Managed metadata string map", () => {
    expect(
      readManagedMetadataObject(
        { github: '{"installationId":"123","eventKind":"issue"}' },
        "github",
      ),
    ).toEqual({ installationId: "123", eventKind: "issue" });
  });

  it("returns null for malformed, scalar, or absent metadata", () => {
    expect(readManagedMetadataObject({ github: "not-json" }, "github")).toBeNull();
    expect(readManagedMetadataObject({ github: '"scalar"' }, "github")).toBeNull();
    expect(readManagedMetadataObject({}, "github")).toBeNull();
  });

  it("accepts the legacy nested value only at the compatibility boundary", () => {
    const legacy = { github: { installationId: "123" } } as unknown as Record<
      string,
      string
    >;
    expect(readManagedMetadataObject(legacy, "github")).toEqual({
      installationId: "123",
    });
  });
});
