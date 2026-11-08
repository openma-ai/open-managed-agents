// Read Harbor task directories from a git repository at one commit, over
// plain HTTPS so it works on Cloudflare Workers (no git binary):
//
//   ref -> commit   git smart-HTTP ref advertisement (info/refs), which every
//                   git host serves, so branches and tags resolve the same way
//                   on GitHub and Hugging Face.
//   files           github.com: one codeload tarball of the commit.
//                   huggingface.co: the Hub tree API (paginated) and one
//                   /resolve/<commit>/<path> download per kept file.
//
// Other hosts are refused with a clear error.

import { maybeGunzipStream, readTarStream, type TarEntry } from "@open-managed-agents/harbor-tasks";
import { EvalBenchmarkError } from "./errors";

export type GitRepo =
  | { host: "github"; url: string; owner: string; repo: string }
  | { host: "huggingface"; url: string; kind: "datasets" | "spaces" | "models"; repo: string };

const USER_AGENT = "open-managed-agents-evals";
const SHA = /^[0-9a-f]{40}$/u;
/** Parallel Hub file downloads. */
const HF_DOWNLOADS = 8;
/** Tree entries listed before giving up (narrow the import with a path). */
const HF_MAX_LISTED = 200_000;

export function isCommitSha(ref: string): boolean { return SHA.test(ref); }

export function parseGitUrl(raw: string): GitRepo {
  let url: URL;
  try { url = new URL(raw); } catch { throw new EvalBenchmarkError(`git url must be an https URL, got ${JSON.stringify(raw)}`); }
  const parts = url.pathname.replace(/\/+$/u, "").replace(/\.git$/u, "").split("/").filter(Boolean);
  if (url.protocol === "https:" && url.hostname === "github.com" && parts.length === 2) {
    return { host: "github", url: `https://github.com/${parts[0]}/${parts[1]}`, owner: parts[0]!, repo: parts[1]! };
  }
  if (url.protocol === "https:" && url.hostname === "huggingface.co") {
    if ((parts[0] === "datasets" || parts[0] === "spaces") && parts.length === 3) {
      return { host: "huggingface", kind: parts[0], repo: `${parts[1]}/${parts[2]}`, url: `https://huggingface.co/${parts.join("/")}` };
    }
    if (parts.length === 2) return { host: "huggingface", kind: "models", repo: parts.join("/"), url: `https://huggingface.co/${parts.join("/")}` };
  }
  throw new EvalBenchmarkError(
    `Unsupported git repository ${raw}: OMA imports Harbor tasks from https://github.com/<owner>/<repo> and https://huggingface.co/datasets/<org>/<name> repositories`,
  );
}

/** name -> sha from a git smart-HTTP ref advertisement (pkt-lines). */
export function parseRefAdvertisement(bytes: Uint8Array): Map<string, string> {
  return readRefAdvertisement(bytes).refs;
}

/** Refs plus the symbolic refs (symref=HEAD:refs/heads/main) the server
 *  announces in the capabilities after the first ref. */
function readRefAdvertisement(bytes: Uint8Array): { refs: Map<string, string>; symrefs: Map<string, string> } {
  const refs = new Map<string, string>();
  const symrefs = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = Number.parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);
    if (!Number.isFinite(length)) break;
    if (length === 0) { offset += 4; continue; }
    if (length < 4) break;
    const line = decoder.decode(bytes.subarray(offset + 4, offset + length)).replace(/\n$/u, "");
    offset += length;
    if (line.startsWith("#")) continue;
    const [head, capabilities] = line.split("\0");
    const [sha, name] = head!.split(" ");
    if (sha !== undefined && name !== undefined && SHA.test(sha) && !/^0{40}$/u.test(sha)) refs.set(name, sha);
    for (const capability of capabilities?.split(" ") ?? []) {
      const match = /^symref=([^:]+):(.+)$/u.exec(capability);
      if (match) symrefs.set(match[1]!, match[2]!);
    }
  }
  return { refs, symrefs };
}

async function fetchAdvertisement(fetchImpl: typeof fetch, repo: GitRepo) {
  const response = await fetchImpl(`${repo.url}.git/info/refs?service=git-upload-pack`, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) {
    // GitHub answers 401 for both missing and private repositories.
    const missing = response.status === 401 || response.status === 404;
    throw new EvalBenchmarkError(`Reading refs of ${repo.url} failed: HTTP ${response.status}${missing ? " (missing or private)" : ""}`, missing ? 404 : 502);
  }
  return readRefAdvertisement(new Uint8Array(await response.arrayBuffer()));
}

/** Refs listed per kind before the list is cut (truncated: true). */
const MAX_LISTED_REFS = 1000;

export interface GitRefList {
  url: string;
  /** The branch HEAD points to; null when the server does not say. */
  default_branch: string | null;
  /** Default branch first, then by name. */
  branches: Array<{ name: string; commit: string }>;
  /** Newest-looking first (natural order, descending); commit is the peeled tag target. */
  tags: Array<{ name: string; commit: string }>;
  /** More than MAX_LISTED_REFS branches or tags; pass the ref by name. */
  truncated: boolean;
}

/** Branches and tags of a repository, for picking a ref. */
export async function listGitRefs(fetchImpl: typeof fetch, repo: GitRepo): Promise<GitRefList> {
  const { refs, symrefs } = await fetchAdvertisement(fetchImpl, repo);
  const head = symrefs.get("HEAD");
  const defaultBranch = head?.startsWith("refs/heads/") ? head.slice("refs/heads/".length) : null;
  const branches: GitRefList["branches"] = [];
  const tags: GitRefList["tags"] = [];
  for (const [name, sha] of refs) {
    if (name.startsWith("refs/heads/")) branches.push({ name: name.slice("refs/heads/".length), commit: sha });
    else if (name.startsWith("refs/tags/") && !name.endsWith("^{}")) tags.push({ name: name.slice("refs/tags/".length), commit: refs.get(`${name}^{}`) ?? sha });
  }
  const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
  branches.sort((a, b) => (a.name === defaultBranch ? -1 : b.name === defaultBranch ? 1 : natural(a.name, b.name)));
  tags.sort((a, b) => natural(b.name, a.name));
  return {
    url: repo.url,
    default_branch: defaultBranch,
    branches: branches.slice(0, MAX_LISTED_REFS),
    tags: tags.slice(0, MAX_LISTED_REFS),
    truncated: branches.length > MAX_LISTED_REFS || tags.length > MAX_LISTED_REFS,
  };
}

/** A full commit sha for `ref` (branch, tag, refs/..., HEAD when omitted, or a sha). */
export async function resolveGitRef(fetchImpl: typeof fetch, repo: GitRepo, ref?: string): Promise<string> {
  if (ref !== undefined && SHA.test(ref)) return ref;
  const { refs } = await fetchAdvertisement(fetchImpl, repo);
  const wanted = ref ?? "HEAD";
  const candidates = wanted === "HEAD" ? ["HEAD"] : wanted.startsWith("refs/") ? [wanted] : [`refs/heads/${wanted}`, `refs/tags/${wanted}`];
  for (const candidate of candidates) {
    const sha = refs.get(`${candidate}^{}`) ?? refs.get(candidate);
    if (sha !== undefined) return sha;
  }
  throw new EvalBenchmarkError(`Ref ${wanted} not found in ${repo.url} (pass a branch, a tag or a full 40-character commit sha)`, 404);
}

function under(path: string, roots: readonly string[] | null): boolean {
  return roots === null || roots.some((root) => root === "" || path.startsWith(`${root}/`));
}

/** Files of the repository at `commit` (paths relative to the repository
 *  root) that lie under one of `roots` (null: anywhere) and that `accept` keeps. */
export async function gitEntries(
  fetchImpl: typeof fetch,
  repo: GitRepo,
  commit: string,
  roots: readonly string[] | null,
  accept: (path: string) => boolean,
): Promise<TarEntry[]> {
  if (!SHA.test(commit)) throw new Error(`gitEntries needs a full commit sha, got ${commit}`);
  return repo.host === "github"
    ? githubEntries(fetchImpl, repo, commit, (path) => under(path, roots) && accept(path))
    : huggingfaceEntries(fetchImpl, repo, commit, roots, accept);
}

async function githubEntries(fetchImpl: typeof fetch, repo: Extract<GitRepo, { host: "github" }>, commit: string, accept: (path: string) => boolean): Promise<TarEntry[]> {
  const url = `https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz/${commit}`;
  const response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok || response.body === null) {
    throw new EvalBenchmarkError(`Downloading ${repo.owner}/${repo.repo}@${commit} failed: HTTP ${response.status}`, 502);
  }
  // GitHub tarballs wrap everything in one "<owner>-<repo>-<sha>/" directory.
  const strip = (path: string) => path.slice(path.indexOf("/") + 1);
  const entries = await readTarStream(maybeGunzipStream(response.body as ReadableStream<Uint8Array>, true), {
    accept: (path) => path.includes("/") && accept(strip(path)),
  });
  return entries.map((entry) => ({ ...entry, path: strip(entry.path) }));
}

function encodePath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }

/** Directory to list on the Hub: one listing of the common parent when many
 *  sibling roots are wanted, else one listing per root. */
function listingRoots(roots: readonly string[] | null): string[] {
  if (roots === null) return [""];
  if (roots.length <= 8) return [...new Set(roots)];
  const parents = new Set(roots.map((root) => root.split("/").slice(0, -1).join("/")));
  return parents.size === 1 && [...parents][0] !== "" ? [...parents] : [...new Set(roots)];
}

async function huggingfaceEntries(
  fetchImpl: typeof fetch,
  repo: Extract<GitRepo, { host: "huggingface" }>,
  commit: string,
  roots: readonly string[] | null,
  accept: (path: string) => boolean,
): Promise<TarEntry[]> {
  const wanted: string[] = [];
  let listed = 0;
  for (const root of listingRoots(roots)) {
    let next: string | null = `https://huggingface.co/api/${repo.kind}/${repo.repo}/tree/${commit}${root === "" ? "" : `/${encodePath(root)}`}?recursive=true&expand=false`;
    while (next !== null) {
      const response: Response = await fetchImpl(next, { headers: { "user-agent": USER_AGENT } });
      if (response.status === 404) throw new EvalBenchmarkError(`${root || "/"} not found in ${repo.url} at ${commit}`, 404);
      if (!response.ok) throw new EvalBenchmarkError(`Listing ${repo.url} at ${commit} failed: HTTP ${response.status}`, 502);
      const page = await response.json() as Array<{ type: string; path: string }>;
      listed += page.length;
      if (listed > HF_MAX_LISTED) throw new EvalBenchmarkError(`${repo.url} has more than ${HF_MAX_LISTED} files under ${root || "/"}; import a narrower path`);
      for (const item of page) if (item.type === "file" && under(item.path, roots) && accept(item.path)) wanted.push(item.path);
      next = /<([^>]+)>;\s*rel="next"/u.exec(response.headers.get("link") ?? "")?.[1] ?? null;
    }
  }
  const prefix = repo.kind === "models" ? "" : `${repo.kind}/`;
  const entries: TarEntry[] = new Array(wanted.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < wanted.length) {
      const index = cursor++;
      const path = wanted[index]!;
      const response = await fetchImpl(`https://huggingface.co/${prefix}${repo.repo}/resolve/${commit}/${encodePath(path)}`, { headers: { "user-agent": USER_AGENT } });
      if (!response.ok) throw new EvalBenchmarkError(`Downloading ${path} from ${repo.url} failed: HTTP ${response.status}`, 502);
      // The Hub tree API carries no file modes; harbor-tasks chmods test.sh/solve.sh itself.
      entries[index] = { path, type: "file", mode: 0o644, bytes: new Uint8Array(await response.arrayBuffer()) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(HF_DOWNLOADS, wanted.length) }, worker));
  return entries;
}
