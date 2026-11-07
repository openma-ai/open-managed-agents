import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import worker from "../src/worker.ts";

const SITE = "https://openma.ai";
const dist = (path) => new URL(`../dist${path}`, import.meta.url);

async function llmsTxt() {
  assert.ok(existsSync(dist("/llms.txt")), "dist/llms.txt is built");
  return readFile(dist("/llms.txt"), "utf8");
}

/** Absolute openma.ai link → built file, or undefined when nothing is built there. */
function builtFileFor(url) {
  const { pathname } = new URL(url);
  const candidates = pathname.endsWith("/")
    ? [`${pathname}index.html`]
    : [pathname, `${pathname}/index.html`];
  return candidates.find((p) => existsSync(dist(p)));
}

function siteLinks(text) {
  return [...text.matchAll(/\]\((https:\/\/openma\.ai[^)\s]*)\)/g)].map((m) => m[1]);
}

test("llms.txt follows the llmstxt.org shape", async () => {
  const text = await llmsTxt();
  assert.ok(text.startsWith("# Open Managed Agents\n"), "H1 first");
  assert.match(text, /^> \S.+$/m, "blockquote summary");
  for (const section of ["Docs", "Guides", "Blog", "Source"]) {
    assert.match(text, new RegExp(`^## ${section}$`, "m"), `## ${section}`);
  }
  assert.match(text, /\]\(https:\/\/docs\.openma\.ai\/\)/);
  assert.match(text, /\]\(https:\/\/docs\.openma\.ai\/llms\.txt\)/);
  assert.match(text, /\]\(https:\/\/github\.com\/openma-ai\/open-managed-agents\)/);
  assert.doesNotMatch(text, /\]\(\/(?!\/)/, "no relative links");
});

test("llms.txt links every top-level marketing page that is built", async () => {
  const text = await llmsTxt();
  const pages = (await readdir(new URL("../src/pages/", import.meta.url)))
    .filter((f) => f.endsWith(".astro") && f !== "index.astro")
    .map((f) => f.replace(/\.astro$/, ""))
    .filter((slug) => existsSync(dist(`/${slug}/index.html`)));
  assert.ok(pages.length >= 11, `found ${pages.length} top-level pages`);
  for (const slug of pages) {
    assert.ok(text.includes(`](${SITE}/${slug}/)`), `llms.txt links /${slug}/`);
  }
});

test("llms.txt lists every non-draft English blog post", async () => {
  const text = await llmsTxt();
  const dir = new URL("../src/content/blog/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => /\.mdx?$/.test(f));
  let listed = 0;
  for (const file of files) {
    const source = await readFile(new URL(file, dir), "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    if (/^draft:\s*true\s*$/m.test(frontmatter)) continue;
    if (/^lang:\s*["']?zh/m.test(frontmatter)) continue;
    const slug = file.replace(/\.mdx?$/, "");
    assert.ok(text.includes(`](${SITE}/blog/${slug}/)`), `llms.txt lists /blog/${slug}/`);
    listed += 1;
  }
  assert.ok(listed > 0, "at least one English post");
  assert.doesNotMatch(text, /\/zh\/blog\//, "no Chinese posts");
});

test("llms.txt only links openma.ai pages that exist in dist/", async () => {
  const links = siteLinks(await llmsTxt());
  assert.ok(links.length > 0);
  for (const url of links) {
    assert.ok(builtFileFor(url), `${url} is built`);
  }
});

test("worker serves /llms.txt as a static asset without redirecting", async () => {
  const assets = {
    async fetch(request) {
      return new Response("asset", { headers: { "x-asset-url": request.url } });
    },
  };
  const response = await worker.fetch(new Request(`${SITE}/llms.txt`), { ASSETS: assets });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("x-asset-url"), `${SITE}/llms.txt`);
});

