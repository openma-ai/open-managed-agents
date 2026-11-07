import { describe, expect, it } from "vitest";
import { gitEntries, listGitRefs, parseGitUrl, parseRefAdvertisement, resolveGitRef } from "../src/git-source";

const enc = (s: string) => new TextEncoder().encode(s);
const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, "0") + line;
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
/** A git smart-HTTP ref advertisement as GitHub and the Hub serve it. */
const advertisement = enc([
  pkt("# service=git-upload-pack\n"), "0000",
  pkt(A + " HEAD\0multi_ack symref=HEAD:refs/heads/main\n"),
  pkt(A + " refs/heads/main\n"),
  pkt(B + " refs/heads/dev\n"),
  pkt(C + " refs/tags/v1\n"),
  pkt(B + " refs/tags/v1^{}\n"),
  "0000",
].join(""));

describe("git sources", () => {
  it("accepts github and huggingface repositories only", () => {
    expect(parseGitUrl("https://github.com/o/r.git/")).toEqual({ host: "github", url: "https://github.com/o/r", owner: "o", repo: "r" });
    expect(parseGitUrl("https://huggingface.co/datasets/org/set")).toEqual({ host: "huggingface", kind: "datasets", repo: "org/set", url: "https://huggingface.co/datasets/org/set" });
    expect(() => parseGitUrl("https://gitlab.com/o/r")).toThrow(/github.com.*huggingface.co/);
    expect(() => parseGitUrl("git@github.com:o/r.git")).toThrow(/https URL/);
  });

  it("parses ref advertisements and resolves branches, peeled tags, HEAD and shas", async () => {
    const refs = parseRefAdvertisement(advertisement);
    expect(refs.get("HEAD")).toBe(A);
    expect(refs.get("refs/tags/v1^{}")).toBe(B);
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => { urls.push(url); return new Response(advertisement); }) as unknown as typeof fetch;
    const repo = parseGitUrl("https://huggingface.co/datasets/org/set");
    expect(await resolveGitRef(fetchImpl, repo)).toBe(A);
    expect(await resolveGitRef(fetchImpl, repo, "dev")).toBe(B);
    expect(await resolveGitRef(fetchImpl, repo, "v1")).toBe(B);
    expect(urls[0]).toBe("https://huggingface.co/datasets/org/set.git/info/refs?service=git-upload-pack");
    await expect(resolveGitRef(fetchImpl, repo, "nope")).rejects.toMatchObject({ status: 404 });
    const before = urls.length;
    expect(await resolveGitRef(fetchImpl, repo, C)).toBe(C);
    expect(urls.length).toBe(before); // a full sha needs no request
  });

  it("lists branches (default first) and tags (peeled, newest first) for picking a ref", async () => {
    const D = "d".repeat(40);
    const many = enc([
      pkt("# service=git-upload-pack\n"), "0000",
      pkt(B + " HEAD\0multi_ack symref=HEAD:refs/heads/trunk agent=git/2\n"),
      pkt(A + " refs/heads/alpha\n"),
      pkt(B + " refs/heads/trunk\n"),
      pkt(C + " refs/pull/1/head\n"),
      pkt(C + " refs/tags/v2\n"),
      pkt(D + " refs/tags/v10\n"),
      pkt(A + " refs/tags/v10^{}\n"),
      "0000",
    ].join(""));
    const repo = parseGitUrl("https://github.com/o/r");
    const refs = await listGitRefs((async () => new Response(many)) as unknown as typeof fetch, repo);
    expect(refs).toEqual({
      url: "https://github.com/o/r",
      default_branch: "trunk",
      branches: [{ name: "trunk", commit: B }, { name: "alpha", commit: A }],
      tags: [{ name: "v10", commit: A }, { name: "v2", commit: C }],
      truncated: false,
    });
    // No symref capability: the default branch is unknown.
    expect((await listGitRefs((async () => new Response(enc(pkt(A + " refs/heads/main\n") + "0000"))) as unknown as typeof fetch, repo)).default_branch).toBeNull();
    await expect(listGitRefs((async () => new Response("", { status: 404 })) as unknown as typeof fetch, repo)).rejects.toMatchObject({ status: 404 });
    await expect(listGitRefs((async () => new Response("", { status: 401 })) as unknown as typeof fetch, repo)).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/missing or private/) });
    await expect(listGitRefs((async () => new Response("", { status: 503 })) as unknown as typeof fetch, repo)).rejects.toMatchObject({ status: 502 });
  });

  it("cuts very long ref lists", async () => {
    const lines = [pkt(A + " HEAD\0symref=HEAD:refs/heads/b0\n")];
    for (let i = 0; i < 1001; i++) lines.push(pkt(A + ` refs/heads/b${i}\n`));
    const refs = await listGitRefs((async () => new Response(enc(lines.join("") + "0000"))) as unknown as typeof fetch, parseGitUrl("https://github.com/o/r"));
    expect(refs.branches).toHaveLength(1000);
    expect(refs.branches[0]!.name).toBe("b0");
    expect(refs.truncated).toBe(true);
  });

  it("reads Hub files through the paginated tree API and /resolve/<commit>", async () => {
    const requested: string[] = [];
    const pages: Record<string, { body: unknown; next?: string }> = {
      first: { body: [{ type: "directory", path: "sets/x/t1" }, { type: "file", path: "sets/x/t1/task.toml" }, { type: "file", path: "sets/x/t1/environment/db.sqlite" }], next: "https://huggingface.co/api/page2" },
      second: { body: [{ type: "file", path: "sets/x/t1/tests/test.sh" }, { type: "file", path: "sets/y/other.md" }] },
    };
    const fetchImpl = (async (url: string) => {
      requested.push(url);
      if (url.startsWith("https://huggingface.co/api/datasets/org/set/tree/")) {
        return new Response(JSON.stringify(pages.first!.body), { headers: { link: '<' + pages.first!.next + '>; rel="next"' } });
      }
      if (url === "https://huggingface.co/api/page2") return new Response(JSON.stringify(pages.second!.body));
      return new Response("content of " + url.split("/resolve/")[1]);
    }) as unknown as typeof fetch;
    const entries = await gitEntries(fetchImpl, parseGitUrl("https://huggingface.co/datasets/org/set"), A, ["sets/x/t1"],
      (path) => !path.includes("/environment/"));
    expect(entries.map((entry) => entry.path)).toEqual(["sets/x/t1/task.toml", "sets/x/t1/tests/test.sh"]);
    expect(new TextDecoder().decode(entries[1]!.bytes)).toBe("content of " + A + "/sets/x/t1/tests/test.sh");
    expect(requested[0]).toBe("https://huggingface.co/api/datasets/org/set/tree/" + A + "/sets/x/t1?recursive=true&expand=false");
    expect(requested).not.toContain("https://huggingface.co/datasets/org/set/resolve/" + A + "/sets/x/t1/environment/db.sqlite");
  });
});
