// /llms.txt — machine-readable site map for LLM agents (https://llmstxt.org).
//
// Static GET endpoint: Astro prerenders it to dist/llms.txt, which the
// worker serves straight from env.ASSETS (the trailing-slash canonical in
// src/worker.ts skips paths whose last segment contains a dot).
//
// Guide notes reuse each page's meta description; blog entries come from
// the same collection filter as blog/rss.xml.ts. Only list pages that
// exist on this site — tests/llms.node.mjs fails on links missing from dist/.

import { getCollection } from "astro:content";

const SITE_URL = "https://openma.ai";
const DOCS_URL = "https://docs.openma.ai";
const REPO_URL = "https://github.com/openma-ai/open-managed-agents";

const GUIDES: Array<{ path: string; title: string; note: string }> = [
  {
    path: "/what-is-claude-managed-agents/",
    title: "What Is Claude Managed Agents?",
    note: "A plain-English guide to Claude Managed Agents: its building blocks, how it differs from the Claude Agent SDK, limits, and the open alternatives.",
  },
  {
    path: "/claude-managed-agents-alternative/",
    title: "Claude Managed Agents Alternative (Open-Source)",
    note: "Compare Claude Managed Agents with self-hosted, multi-model managed runtimes.",
  },
  {
    path: "/self-hosted-ai-agents/",
    title: "Self-Hosted AI Agents",
    note: "Why teams self-host AI agents for control, data residency, and model choice, and how OpenMA runs on your own infrastructure.",
  },
  {
    path: "/open-source-ai-agents/",
    title: "Open-Source AI Agents & Agent Platforms Compared",
    note: "Open-source AI agents and agent platforms compared by category: managed runtimes, harnesses, frameworks, and coding agents.",
  },
  {
    path: "/open-source-managed-agents/",
    title: "Open-Source Managed Agent Runtimes Compared",
    note: "Compare open-source managed agent runtimes by agents, sessions, sandboxes, and vaults you can self-host with any model.",
  },
  {
    path: "/ai-agent-platform/",
    title: "AI Agent Platform & Orchestration Runtime",
    note: "What an AI agent platform is: orchestration, sessions, sandboxes, model routing, and durability.",
  },
  {
    path: "/agent-as-a-service/",
    title: "Agent as a Service",
    note: "Agent as a service: a runtime runs your agents behind an API, with sessions, sandboxes, tools, credentials and recovery. Use OpenMA hosted or self-host it.",
  },
  {
    path: "/compare/",
    title: "Compare OpenMA vs Agent Platforms and Runtimes",
    note: "OpenMA compared with Claude Managed Agents, OpenAI Agents API, Kimi Hosted Agents, open-source runtimes and coding agents, with links to each comparison.",
  },
  {
    path: "/claude-tag-alternative/",
    title: "Open-Source Claude Tag Alternative You Can Self-Host",
    note: "Build a Claude Tag-style agent on Docker or Cloudflare with Slack, MCP, private tools, durable sessions and BYOK models.",
  },
  {
    path: "/claude-tag-open-source/",
    title: "Open-Source Claude Tag",
    note: "Claude Tag is not open source; Open Managed Agents is an Apache 2.0 foundation for building Claude Tag-style agents.",
  },
  {
    path: "/self-hosted-claude-tag/",
    title: "Self-Hosted Claude Tag",
    note: "A self-hosted foundation for a Claude Tag-style workflow with BYOK, MCP, vaults, memory stores, and durable sessions.",
  },
  {
    path: "/pricing/",
    title: "Hosted Pricing",
    note: "Self-host OpenMA for free; hosted openma.ai is optional wallet-based sandbox compute, BYOK for the LLM.",
  },
  {
    path: "/deploy/",
    title: "Deploy OpenMA",
    note: "Choose a topology and get a deployment plan for Cloudflare, Docker, Fly.io, or Vercel.",
  },
];

const DOCS: Array<{ url: string; title: string; note: string }> = [
  {
    url: `${DOCS_URL}/`,
    title: "Documentation",
    note: "Full OpenMA documentation: concepts, API, self-hosting, sandboxes, and reference.",
  },
  {
    url: `${DOCS_URL}/llms.txt`,
    title: "Docs llms.txt",
    note: "Index of every English documentation page with a one-line summary.",
  },
  {
    url: `${DOCS_URL}/quickstart/`,
    title: "Quickstart",
    note: "Sign up, get an API key, and run your first agent session.",
  },
  {
    url: `${DOCS_URL}/self-host/overview/`,
    title: "Self-host Overview",
    note: "Self-host on Cloudflare Workers or as a single Node process. Same code, same API.",
  },
];

const link = (title: string, url: string, note: string) =>
  `- [${title}](${url}): ${note.replace(/\s+/g, " ").trim()}`;

export async function GET() {
  const posts = (await getCollection("blog", ({ data }) => !data.draft && data.lang === "en"))
    .sort((a, b) => b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf());

  const body = [
    "# Open Managed Agents",
    "",
    "> OpenMA handles sessions, execution and recovery, so you can build and run agents with any model, any harness, any sandbox, on any cloud. An open-source, self-hostable alternative to Claude Managed Agents and OpenAI Agents API.",
    "",
    "OpenMA is Apache-2.0 licensed. Use hosted openma.ai or self-host on Node.js, Docker, Fly.io, Vercel (Beta) or Cloudflare.",
    "",
    "## Docs",
    "",
    ...DOCS.map((d) => link(d.title, d.url, d.note)),
    "",
    "## Guides",
    "",
    ...GUIDES.map((g) => link(g.title, `${SITE_URL}${g.path}`, g.note)),
    "",
    "## Blog",
    "",
    ...posts.map((post) => link(post.data.title, `${SITE_URL}/blog/${post.id}/`, post.data.description)),
    "",
    "## Source",
    "",
    link("GitHub repository", REPO_URL, "Source code, issues, and releases (Apache-2.0)."),
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
