// Harbor's package content hash, so OMA case digests use the same
// algorithm as `harbor publish` (harbor/publisher/packager.py
// compute_content_hash): sha256 over "${path}\0${sha256(file)}\n" for every
// file, files sorted by path. Modes are not part of it.

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
}

/** "sha256:<hex>" over `files` (paths relative to the task root). */
export async function harborContentDigest(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): Promise<string> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines = await Promise.all(sorted.map(async (file) => `${file.path}\0${await sha256Hex(file.bytes)}\n`));
  return `sha256:${await sha256Hex(new TextEncoder().encode(lines.join("")))}`;
}
