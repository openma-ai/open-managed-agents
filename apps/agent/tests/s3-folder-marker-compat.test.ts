import { describe, expect, it } from "vitest";
import { missingS3fsFolderMarker } from "../src/runtime/s3-folder-marker-compat";

const props = { source: { bucket: "files" }, keyPrefix: "t/default/session-outputs/session_abc/" };

describe("s3fs folder marker compatibility", () => {
  it("returns missing-object for the prefix root marker probe", () => {
    const response = missingS3fsFolderMarker(
      new Request("http://route/files/t/default/session-outputs/session_abc_$folder$", { method: "HEAD" }),
      props,
    );
    expect(response?.status).toBe(404);
  });

  it("does not widen the prefix or alter ordinary requests", () => {
    expect(missingS3fsFolderMarker(
      new Request("http://route/files/t/default/session-outputs/other_$folder$", { method: "HEAD" }),
      props,
    )).toBeNull();
    expect(missingS3fsFolderMarker(
      new Request("http://route/files/t/default/session-outputs/session_abc_$folder$", { method: "GET" }),
      props,
    )).toBeNull();
  });
});
