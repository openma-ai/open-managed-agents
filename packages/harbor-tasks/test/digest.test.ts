import { describe, expect, it } from "vitest";
import { harborContentDigest } from "../src/digest";

const enc = (s: string) => new TextEncoder().encode(s);

describe("harborContentDigest", () => {
  it("matches Harbor's Packager.compute_content_hash byte for byte", async () => {
    // Reference value from harbor/publisher/packager.py's algorithm in Python
    // (sha256 over sorted "rel\0sha256(file)\n" lines).
    const files = [
      { path: "tests/test.sh", bytes: enc("#!/bin/bash\n") },
      { path: "task.toml", bytes: enc('[environment]\ndocker_image = "img/a:1"\n') },
      { path: "instruction.md", bytes: enc("do a") },
    ];
    expect(await harborContentDigest(files)).toBe("sha256:e41bc0ff0ffd2ed63232ecb198db1047c6656c86133ac19718e6818add8a1b32");
  });

  it("ignores file order and changes with any byte", async () => {
    const a = [{ path: "a", bytes: enc("1") }, { path: "b", bytes: enc("2") }];
    expect(await harborContentDigest(a)).toBe(await harborContentDigest([...a].reverse()));
    expect(await harborContentDigest(a)).not.toBe(await harborContentDigest([{ path: "a", bytes: enc("1") }, { path: "b", bytes: enc("3") }]));
  });
});
