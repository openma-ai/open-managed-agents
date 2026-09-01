import { describe, expect, it } from "vitest";
import { extractManagedSkillFiles } from "./skill-upload";

function buffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function fromBase64(value: string): ArrayBuffer {
  return buffer(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
}

const SKILL_ZIP =
  "UEsDBBQAAAAIAMR+IV0xf2QlFwAAABYAAAARAAAAcmVzZWFyY2gvU0tJTEwubWTT1dXlykvMTbVSKEotTk0sSs7gAgoBAFBLAwQUAAAACADEfiFdNceeygcAAAAFAAAAHAAAAHJlc2VhcmNoL3JlZmVyZW5jZXMvZ3VpZGUubWRLL81MSQUAUEsBAhQAFAAAAAgAxH4hXTF/ZCUXAAAAFgAAABEAAAAAAAAAAAAAAAAAAAAAAHJlc2VhcmNoL1NLSUxMLm1kUEsBAhQAFAAAAAgAxH4hXTXHnsoHAAAABQAAABwAAAAAAAAAAAAAAAAARgAAAHJlc2VhcmNoL3JlZmVyZW5jZXMvZ3VpZGUubWRQSwUGAAAAAAIAAgCJAAAAhwAAAAAA";
const EMPTY_ZIP = "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==";

describe("extractManagedSkillFiles", () => {
  it("turns a skill zip into SDK-style files[] while preserving paths", async () => {
    const zip = new File(
      [
        fromBase64(SKILL_ZIP),
      ],
      "research.zip",
      { type: "application/zip" },
    );

    expect(zip.size).toBeGreaterThan(0);
    expect((await zip.arrayBuffer()).byteLength).toBe(zip.size);
    const files = await extractManagedSkillFiles(zip);
    expect(files.map((file) => file.name).sort()).toEqual([
      "research/SKILL.md",
      "research/references/guide.md",
    ]);
    expect(await files[0].text()).toContain("name: research");
  });

  it("rejects an empty archive before making a request", async () => {
    const zip = new File([fromBase64(EMPTY_ZIP)], "empty.zip");
    await expect(extractManagedSkillFiles(zip)).rejects.toThrow("does not contain any files");
  });
});
