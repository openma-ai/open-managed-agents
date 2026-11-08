import { describe, expect, it } from "vitest";
import { createR2TemporaryCredentials, createS3OutputSink, readSandboxOutputs } from "../src/object-storage";
import type { SandboxVendorPort } from "../src/ports";

const PARENT_SECRET = "parent-secret-never-in-sandbox";
const parent = {
  accountId: "acct",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  bucket: "memory",
  accessKeyId: "parent-key-id",
  secretAccessKey: PARENT_SECRET,
};
const scope = { workspaceId: "ws", sessionId: "sess", environmentId: "env" } as never;
const fence = { workId: "work", generation: 1, ownerId: "owner", fenceToken: "t" } as never;

function decodeJwtPayload(sessionToken: string): Record<string, unknown> {
  const jwt = atob(sessionToken).replace(/^jwt\//u, "");
  const payload = jwt.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
}

describe("createR2TemporaryCredentials", () => {
  it("signs prefix-scoped, short-lived credentials without exposing the parent secret", async () => {
    const issued = await createR2TemporaryCredentials(parent, () => 1_700_000_000_000)
      .issue({ prefix: "/store_1", access: "read_only", ttlSeconds: 900 });
    expect(issued.prefix).toBe("store_1/");
    expect(issued.accessKeyId).toBe("parent-key-id");
    expect(issued.expiresAt).toBe(1_700_000_900_000);
    expect(JSON.stringify(issued)).not.toContain(PARENT_SECRET);
    const jwt = atob(issued.sessionToken).slice("jwt/".length);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jwt)));
    expect(issued.secretAccessKey).toBe(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""));
    expect(decodeJwtPayload(issued.sessionToken)).toEqual({
      bucket: "memory",
      scope: "object-read-only",
      paths: { prefixPaths: ["store_1/"], objectPaths: [] },
      sub: "acct",
      iss: "parent-key-id",
      aud: "acct.r2.cloudflarestorage.com",
      iat: 1_700_000_000,
      exp: 1_700_000_900,
    });
  });

  it("grants read-write only when asked and refuses unsafe prefixes", async () => {
    const port = createR2TemporaryCredentials(parent);
    const rw = await port.issue({ prefix: "store_2/", access: "read_write", ttlSeconds: 60 });
    expect(decodeJwtPayload(rw.sessionToken).scope).toBe("object-read-write");
    await expect(port.issue({ prefix: "", access: "read_only", ttlSeconds: 60 })).rejects.toThrow(/Unsafe/);
    await expect(port.issue({ prefix: "a/../b", access: "read_only", ttlSeconds: 60 })).rejects.toThrow(/Unsafe/);
    await expect(port.issue({ prefix: "a", access: "read_only", ttlSeconds: 0 })).rejects.toThrow(/ttlSeconds/);
  });
});

describe("createS3OutputSink", () => {
  it("uploads every output under the Session prefix and deletes stale keys", async () => {
    const calls: Array<{ method: string; url: string; authorization: string | null }> = [];
    const sink = createS3OutputSink({
      endpoint: "https://acct.r2.cloudflarestorage.com/",
      bucket: "files",
      accessKeyId: "parent-key-id",
      secretAccessKey: PARENT_SECRET,
      keyPrefix: (s) => `t/${s.workspaceId}/session-outputs/${s.sessionId}/`,
      fetch: async (input) => {
        const request = input as Request;
        calls.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization") });
        if (request.method === "GET") {
          return new Response("<ListBucketResult><Key>t/ws/session-outputs/sess/old.txt</Key><Key>t/ws/session-outputs/sess/a b.txt</Key><IsTruncated>false</IsTruncated></ListBucketResult>");
        }
        return new Response(null, { status: 200 });
      },
    });
    async function* files() {
      yield ["a b.txt", new TextEncoder().encode("hello")] as const;
      yield ["dir/report.md", new TextEncoder().encode("# r")] as const;
    }
    await sink.publish({ scope, fence, files: files(), signal: new AbortController().signal });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://acct.r2.cloudflarestorage.com/files?list-type=2&prefix=t%2Fws%2Fsession-outputs%2Fsess%2F",
      "PUT https://acct.r2.cloudflarestorage.com/files/t/ws/session-outputs/sess/a%20b.txt",
      "PUT https://acct.r2.cloudflarestorage.com/files/t/ws/session-outputs/sess/dir/report.md",
      "DELETE https://acct.r2.cloudflarestorage.com/files/t/ws/session-outputs/sess/old.txt",
    ]);
    for (const call of calls) {
      expect(call.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=parent-key-id\//u);
      expect(call.authorization).not.toContain(PARENT_SECRET);
    }
  });

  it("refuses unsafe logical paths and failed uploads", async () => {
    const sink = createS3OutputSink({
      endpoint: "https://s3.example.com", bucket: "files", accessKeyId: "k", secretAccessKey: "s",
      keyPrefix: () => "p/",
      fetch: async (input) => new Response((input as Request).method === "GET" ? "<IsTruncated>false</IsTruncated>" : null, { status: (input as Request).method === "PUT" ? 500 : 200 }),
    });
    async function* bad() { yield ["../x", new Uint8Array()] as const; }
    async function* ok() { yield ["x", new Uint8Array([1])] as const; }
    await expect(sink.publish({ scope, fence, files: bad(), signal: new AbortController().signal })).rejects.toThrow(/Unsafe/);
    await expect(sink.publish({ scope, fence, files: ok(), signal: new AbortController().signal })).rejects.toThrow(/500/);
  });
});

describe("readSandboxOutputs", () => {
  it("lists /mnt/session/outputs and reads each regular file", async () => {
    const listing = btoa("./a.txt\0./sub/b.bin\0");
    const vendor: Pick<SandboxVendorPort<object>, "exec" | "readFile"> = {
      exec: async () => ({ exitCode: 0, stdout: listing, stderr: "" }),
      readFile: async (_r, path) => new TextEncoder().encode(path),
    };
    const out: Array<[string, string]> = [];
    for await (const [path, bytes] of readSandboxOutputs(vendor, {})) out.push([path, new TextDecoder().decode(bytes)]);
    expect(out).toEqual([["a.txt", "/mnt/session/outputs/a.txt"], ["sub/b.bin", "/mnt/session/outputs/sub/b.bin"]]);
  });

  it("fails on a listing error instead of publishing an empty set", async () => {
    const vendor = { exec: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }), readFile: async () => null };
    await expect(readSandboxOutputs(vendor, {}).next()).rejects.toThrow(/boom/);
  });
});
