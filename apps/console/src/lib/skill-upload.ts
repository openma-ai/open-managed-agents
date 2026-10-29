import { unzipSync } from "fflate";

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Keep the product's convenient zip picker while emitting the Managed Skills
 * API's `files[]` shape. File names retain their archive-relative paths so the
 * server can validate the required top-level directory and SKILL.md.
 */
export async function extractManagedSkillFiles(zip: File): Promise<File[]> {
  const archive = unzipSync(new Uint8Array(await zip.arrayBuffer()));
  const files = Object.entries(archive)
    .filter(([path]) => path !== "" && !path.endsWith("/"))
    .map(([path, bytes]) => new File([ownedArrayBuffer(bytes)], path));

  if (files.length === 0) {
    throw new Error("The skill archive does not contain any files");
  }
  return files;
}

export interface SkillArchivePreviewFile {
  filename: string;
  content: string;
  encoding: "utf8" | "base64";
}

/**
 * Turn a Managed Skills API version archive (`GET /v1/skills/:id/versions/
 * :version/content`, a zip) into preview entries. Text files are decoded as
 * UTF-8; anything that is not valid UTF-8 is flagged as binary and its body
 * is not decoded, since the preview never renders binary content.
 */
export function readSkillArchivePreview(
  archiveBytes: Uint8Array,
): SkillArchivePreviewFile[] {
  const archive = unzipSync(archiveBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return Object.entries(archive)
    .filter(([path]) => path !== "" && !path.endsWith("/"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filename, bytes]) => {
      try {
        return { filename, content: decoder.decode(bytes), encoding: "utf8" };
      } catch {
        return { filename, content: "", encoding: "base64" };
      }
    });
}
