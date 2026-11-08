/**
 * Minimal, dependency-free tar reader (ustar + pax + GNU long names) with
 * transparent gzip, for Harbor task bundles. Runs on Node and Workers: gzip
 * goes through the standard DecompressionStream.
 */

export interface TarEntry {
  /** Normalised relative path, no leading "./" or "/". */
  path: string;
  type: "file" | "directory";
  mode: number;
  bytes: Uint8Array;
}

const MAX_ENTRIES = 50_000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function text(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(offset, end));
}

function octal(block: Uint8Array, offset: number, length: number): number {
  const raw = text(block, offset, length).trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/u.test(raw)) throw new Error(`Invalid tar header number ${JSON.stringify(raw)}`);
  return Number.parseInt(raw, 8);
}

function parsePax(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  const content = new TextDecoder().decode(data);
  let index = 0;
  while (index < content.length) {
    const space = content.indexOf(" ", index);
    if (space < 0) break;
    const length = Number.parseInt(content.slice(index, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = content.slice(space + 1, index + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    index += length;
  }
  return records;
}

/** Reject absolute paths and ".." so a bundle can never name a file outside itself. */
export function normaliseArchivePath(path: string): string | null {
  const parts = path.replace(/\\/gu, "/").split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

export interface ReadTarOptions {
  /** Keep only entries this returns true for; others are skipped unread.
   *  Links are refused only when accepted (GitHub tarballs contain links
   *  outside task directories). Default: keep everything. */
  accept?: (path: string) => boolean;
}

/** Growable byte queue for the streaming reader. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  length = 0;
  push(chunk: Uint8Array) { if (chunk.length > 0) { this.chunks.push(chunk); this.length += chunk.length; } }
  /** Remove and return the first n bytes (n <= length). */
  take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0]!;
      const need = n - filled;
      if (head.length <= need) { out.set(head, filled); filled += head.length; this.chunks.shift(); }
      else { out.set(head.subarray(0, need), filled); this.chunks[0] = head.subarray(need); filled = n; }
    }
    this.length -= n;
    return out;
  }
  /** Drop up to n bytes; returns how many were dropped. */
  skip(n: number): number {
    let dropped = 0;
    while (dropped < n && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const need = n - dropped;
      if (head.length <= need) { dropped += head.length; this.chunks.shift(); }
      else { this.chunks[0] = head.subarray(need); dropped = n; }
    }
    this.length -= dropped;
    return dropped;
  }
}

/**
 * Read a tar stream (already decompressed) keeping only accepted entries.
 * Memory stays bounded by the accepted bytes, so a large repository
 * tarball can be filtered down to a few task directories.
 */
export async function readTarStream(stream: ReadableStream<Uint8Array>, options: ReadTarOptions = {}): Promise<TarEntry[]> {
  const accept = options.accept ?? (() => true);
  const reader = stream.getReader();
  const queue = new ByteQueue();
  let ended = false;
  const fill = async (n: number): Promise<boolean> => {
    while (queue.length < n && !ended) {
      const { done, value } = await reader.read();
      if (done) ended = true; else queue.push(value);
    }
    return queue.length >= n;
  };
  const discard = async (n: number) => {
    let left = n;
    while (left > 0) {
      left -= queue.skip(left);
      if (left > 0) { if (!(await fill(1))) throw new Error("Truncated tar archive"); }
    }
  };
  const entries: TarEntry[] = [];
  let total = 0;
  let seen = 0;
  let longName: string | null = null;
  let pax: Record<string, string> = {};
  try {
    for (;;) {
      if (!(await fill(512))) break;
      const header = queue.take(512);
      if (header.every((byte) => byte === 0)) break;
      const size = octal(header, 124, 12);
      const padded = Math.ceil(size / 512) * 512;
      const typeflag = String.fromCharCode(header[156] || 0x30);
      const readData = async () => {
        if (!(await fill(padded))) throw new Error("Truncated tar archive");
        const data = queue.take(padded);
        return data.subarray(0, size);
      };
      if (typeflag === "L") { const data = await readData(); longName = text(data, 0, data.length); continue; }
      if (typeflag === "x") { pax = parsePax(await readData()); continue; }
      if (typeflag === "g") { await discard(padded); continue; }
      const prefix = text(header, 345, 155);
      const name = pax.path ?? longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
      longName = null;
      pax = {};
      if (++seen > MAX_ENTRIES * 20) throw new Error("Archive has too many entries");
      const path = normaliseArchivePath(name);
      if (path === null) throw new Error(`Unsafe path in archive: ${name}`);
      if (path === "" || !accept(path)) { await discard(padded); continue; }
      const mode = octal(header, 100, 8);
      if (typeflag === "5") {
        await discard(padded);
        entries.push({ path, type: "directory", mode, bytes: new Uint8Array() });
      } else if (typeflag === "0" || typeflag === "\0" || typeflag === "7") {
        total += size;
        if (total > MAX_TOTAL_BYTES) throw new Error("Archive exceeds 1 GiB uncompressed");
        entries.push({ path, type: "file", mode, bytes: (await readData()).slice() });
      } else {
        throw new Error(`Unsupported tar entry type ${JSON.stringify(typeflag)} for ${path} (links are not allowed in task bundles)`);
      }
      if (entries.length > MAX_ENTRIES) throw new Error("Archive has too many entries");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return entries;
}

/** Decompress gzip when the stream starts with the gzip magic bytes. */
export function maybeGunzipStream(stream: ReadableStream<Uint8Array>, gzip: boolean): ReadableStream<Uint8Array> {
  return gzip ? stream.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>) : stream;
}

export async function readTarArchive(input: Uint8Array, options: ReadTarOptions = {}): Promise<TarEntry[]> {
  const gzip = input[0] === 0x1f && input[1] === 0x8b;
  const stream = new Blob([new Uint8Array(input)]).stream() as ReadableStream<Uint8Array>;
  return readTarStream(maybeGunzipStream(stream, gzip), options);
}
