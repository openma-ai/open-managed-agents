import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { websiteSchema } from "../src/lib/seo.ts";
import worker from "../src/worker.ts";

const assets = {
  async fetch(request) {
    return new Response("asset", {
      headers: { "x-asset-url": request.url },
    });
  },
};

async function fetchFromWorker(url) {
  return worker.fetch(new Request(url), { ASSETS: assets });
}

test("legacy Anthropic article URLs permanently redirect to the live Claude URLs", async () => {
  const redirects = new Map([
    [
      "/blog/open-source-alternatives-to-anthropic-managed-agents-2026/",
      "/claude-managed-agents-alternative/",
    ],
    [
      "/blog/open-source-alternatives-to-claude-managed-agents-2026/",
      "/claude-managed-agents-alternative/",
    ],
    [
      "/blog/migrate-from-anthropic-managed-agents/",
      "/blog/migrate-from-claude-managed-agents/",
    ],
    [
      "/blog/anthropic-managed-agents-vs-open-managed-agents/",
      "/blog/claude-managed-agents-vs-open-managed-agents/",
    ],
    ["/blog/why-agent-as-a-service/", "/blog/"],
    ["/sitemap.xml", "/sitemap-index.xml"],
  ]);

  for (const [from, to] of redirects) {
    const response = await fetchFromWorker(`https://openma.ai${from}?ref=old-link`);

    assert.equal(response.status, 301, from);
    assert.equal(
      response.headers.get("location"),
      `https://openma.ai${to}?ref=old-link`,
      from,
    );
  }
});


test("apex /docs permanently redirects to the docs subdomain", async () => {
  const response = await fetchFromWorker("https://openma.ai/docs");
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), "https://docs.openma.ai/");
});

test("extensionless /pricing permanently redirects to trailing-slash canonical", async () => {
  const response = await fetchFromWorker("https://openma.ai/pricing?ref=nav");
  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("location"),
    "https://openma.ai/pricing/?ref=nav",
  );
});

test("extensionless marketing URLs permanently redirect to their trailing-slash canonical", async () => {
  const response = await fetchFromWorker(
    "https://openma.ai/blog/architecture-durable-objects-r2-brain-sandbox-split?source=gsc",
  );

  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("location"),
    "https://openma.ai/blog/architecture-durable-objects-r2-brain-sandbox-split/?source=gsc",
  );
});

test("managed-agents guide landings redirect to their trailing-slash canonical", async () => {
  for (const path of [
    "/claude-managed-agents-alternative",
    "/what-is-claude-managed-agents",
    "/self-hosted-ai-agents",
    "/open-source-ai-agents",
    "/open-source-managed-agents",
    "/ai-agent-platform",
  ]) {
    const response = await fetchFromWorker(`https://openma.ai${path}`);
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get("location"), `https://openma.ai${path}/`, path);
  }
});

test("static assets bypass trailing-slash redirects", async () => {
  const response = await fetchFromWorker("https://openma.ai/robots.txt");

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-asset-url"),
    "https://openma.ai/robots.txt",
  );
});

test("API-shaped paths bypass marketing trailing-slash redirects", async () => {
  const response = await fetchFromWorker("https://openma.ai/v1/agents");

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-asset-url"),
    "https://openma.ai/v1/agents",
  );
});

test("WebSite structured data does not advertise a search endpoint that returns 404", () => {
  const schema = websiteSchema();

  assert.equal("potentialAction" in schema, false);
});

test("high-impression landing pages emit concise, user-facing search snippets", async () => {
  const homepage = await readFile(
    new URL("../dist/index.html", import.meta.url),
    "utf8",
  );
  const alternative = await readFile(
    new URL("../dist/claude-tag-alternative/index.html", import.meta.url),
    "utf8",
  );

  const title = homepage.match(/<title>([^<]+)<\/title>/)?.[1];
  const description = homepage.match(/<meta name="description" content="([^"]+)"/)?.[1];
  assert.match(title, /OpenMA/);
  assert.match(title, /Claude Managed Agents/);
  assert.match(title, /OpenAI Agents API/);
  assert.ok(title.length <= 65, "homepage title stays concise");
  assert.match(description, /Open Managed Agents/);
  assert.match(description, /OpenAI Agents API/);
  assert.match(description, /Hosted or self-hosted/);
  assert.match(homepage, /<h1[^>]*>\s*Open Managed Agents\s*<\/h1>/);
  assert.ok(description.length <= 170, "homepage description stays concise");
  assert.equal(homepage.match(/<meta property="og:description" content="([^"]+)"/)?.[1], description);
  assert.match(homepage, /href="#openai-agents-api"/);
  assert.match(homepage, /id="openai-agents-api"/);
  assert.match(
    alternative,
    /<title>Open-Source Claude Tag Alternative You Can Self-Host \| OpenMA<\/title>/,
  );
  assert.match(
    alternative,
    /<meta name="description" content="Build a Claude Tag-style agent on Docker or Cloudflare with Slack, MCP, private tools, durable sessions and BYOK models\. Apache-2\.0\."/,
  );
  assert.match(
    alternative,
    /href="https:\/\/docs\.openma\.ai\/build\/vault-and-mcp\/"/,
  );
  assert.doesNotMatch(alternative, /Search intent match/i);
});

test("generated pages do not expose internal SEO language to visitors", async () => {
  const pagePaths = [
    "../dist/claude-tag-alternative/index.html",
    "../dist/claude-tag-open-source/index.html",
    "../dist/self-hosted-claude-tag/index.html",
  ];

  for (const pagePath of pagePaths) {
    const html = await readFile(new URL(pagePath, import.meta.url), "utf8");
    assert.doesNotMatch(
      html,
      /Search intent match|matters for SEO|The SEO and product category/i,
      pagePath,
    );
  }
});


test("OpenAI Agents API article is published with a GitHub project path", async () => {
  const article = await readFile(
    new URL("../dist/blog/openai-agents-api-self-hosted/index.html", import.meta.url),
    "utf8",
  );
  const blogIndex = await readFile(new URL("../dist/blog/index.html", import.meta.url), "utf8");
  const sitemap = await readFile(new URL("../dist/sitemap-0.xml", import.meta.url), "utf8");

  assert.match(article, /Which parts are open source\?/);
  assert.match(article, /OpenAI Agents SDK/);
  assert.match(article, /star the repository on GitHub/);
  assert.match(article, /href="https:\/\/github\.com\/openma-ai\/open-managed-agents"/);
  assert.match(blogIndex, /href="\/blog\/openai-agents-api-self-hosted\/"/);
  assert.match(sitemap, /\/blog\/openai-agents-api-self-hosted\//);
});

test("FAQ and breadcrumb JSON-LD parse and match visible page content", async () => {
  const { readdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const pages = [
    "ai-agent-platform", "claude-managed-agents-alternative", "open-source-managed-agents",
    "self-hosted-ai-agents", "what-is-claude-managed-agents", "open-source-ai-agents",
    "claude-tag-alternative", "claude-tag-open-source", "self-hosted-claude-tag",
  ];
  const posts = (await readdir(new URL("../src/content/blog/", import.meta.url)))
    .filter((f) => f.endsWith(".md")).map((f) => `blog/${f.replace(/\.md$/, "")}`);
  const decode = (t) => t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  for (const page of [...pages, ...posts]) {
    const html = await readFile(new URL(`../dist/${page}/index.html`, import.meta.url), "utf8");
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]));
    const crumbs = blocks.filter((b) => b["@type"] === "BreadcrumbList");
    assert.equal(crumbs.length, 1, `${page}: one BreadcrumbList`);
    assert.match(html, /aria-label="Breadcrumb"/, `${page}: visible breadcrumbs`);
    const text = decode(html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, ""));
    for (const faq of blocks.filter((b) => b["@type"] === "FAQPage")) {
      for (const q of faq.mainEntity) {
        assert.ok(text.includes(q.name), `${page}: visible question "${q.name}"`);
        assert.ok(text.includes(q.acceptedAnswer.text), `${page}: visible answer for "${q.name}"`);
      }
    }
    const og = html.match(/property="og:image" content="https:\/\/openma\.ai([^"]+)"/)[1];
    assert.match(og, /^\/og\//, `${page}: per-page og:image`);
    assert.ok(existsSync(new URL(`../public${og}`, import.meta.url)), `${page}: ${og} exists`);
  }
});
