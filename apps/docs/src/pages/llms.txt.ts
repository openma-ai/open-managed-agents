// /llms.txt — index of the English docs for LLM agents (https://llmstxt.org).
//
// A plain Astro endpoint rather than the starlight-llms-txt plugin: Starlight
// only injects its own [...slug] route, so this static route wins and
// prerenders to dist/llms.txt. Entries come from the `docs` collection
// (title + description frontmatter); the zh-cn locale is excluded.
// Sections roughly mirror the sidebar in astro.config.mjs — keep SECTIONS
// in step when a sidebar group is added. Unmatched pages land in "Other".

import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

const SITE = 'https://docs.openma.ai';

const SECTIONS: Array<{ title: string; match: (id: string) => boolean; first?: string[] }> = [
  {
    title: 'Get Started',
    match: (id) =>
      ['index', 'quickstart', 'concepts', 'sandboxes', 'claude-managed-agents-compatibility'].includes(id) ||
      id.startsWith('ecosystem/'),
    first: ['index', 'quickstart', 'concepts', 'sandboxes', 'claude-managed-agents-compatibility'],
  },
  { title: 'Use the Console', match: (id) => id.startsWith('console/'), first: ['console/getting-started'] },
  {
    title: 'Build with the API',
    match: (id) => id.startsWith('build/'),
    first: ['build/api', 'build/kimi-hosted-agents', 'build/cli-sdk', 'build/skills-and-tools', 'build/vault-and-mcp'],
  },
  {
    title: 'Self-host',
    match: (id) => id.startsWith('self-host/') && !id.startsWith('self-host/sandbox/'),
    first: ['self-host/overview', 'self-host/node-docker', 'self-host/fly', 'self-host/render'],
  },
  { title: 'Sandbox providers', match: (id) => id.startsWith('self-host/sandbox/') },
  { title: 'Reference', match: (id) => id.startsWith('reference/'), first: ['reference/configuration', 'reference/api'] },
  { title: 'Contribute', match: (id) => id === 'contribute' || id.startsWith('contribute/'), first: ['contribute'] },
];

const pageUrl = (id: string) => (id === 'index' || id === '' ? `${SITE}/` : `${SITE}/${id}/`);
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export const GET: APIRoute = async () => {
  const pages = (await getCollection('docs', ({ id, data }) => !id.startsWith('zh-cn/') && !data.draft))
    .map((entry) => ({ id: entry.id === '' ? 'index' : entry.id, data: entry.data }));

  const used = new Set<string>();
  const sections = [...SECTIONS, { title: 'Other', match: () => true }].map((section) => {
    const first = 'first' in section ? section.first ?? [] : [];
    const rank = (id: string) => (first.includes(id) ? first.indexOf(id) : first.length);
    const entries = pages
      .filter((page) => !used.has(page.id) && section.match(page.id))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    for (const entry of entries) used.add(entry.id);
    return { title: section.title, entries };
  });

  const lines = [
    '# Open Managed Agents Documentation',
    '',
    '> Open-source Claude Managed Agents alternative with OpenAI Agents API support. Self-host on Node + Docker or Cloudflare, or use hosted openma.ai.',
    '',
    'Every page below is English. Simplified Chinese translations of some pages live under https://docs.openma.ai/zh-cn/.',
  ];
  for (const section of sections) {
    if (section.entries.length === 0) continue;
    lines.push('', `## ${section.title}`, '');
    for (const { id, data } of section.entries) {
      const note = data.description ? `: ${oneLine(data.description)}` : '';
      lines.push(`- [${oneLine(data.title)}](${pageUrl(id)})${note}`);
    }
  }
  lines.push(
    '',
    '## Optional',
    '',
    '- [openma.ai llms.txt](https://openma.ai/llms.txt): Marketing guides, comparisons, and blog posts.',
    '- [GitHub repository](https://github.com/openma-ai/open-managed-agents): Source code, issues, and releases (Apache-2.0).',
    '',
  );

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
