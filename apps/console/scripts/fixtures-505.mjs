// Synthetic API fixtures for the #505 route captures; no backend or credentials.
export function makeFixtures(base) {
const iso = (d) => `2026-11-0${d}T10:00:00.000Z`;
const epoch = (d) => Math.floor(Date.parse(iso(d)) / 1000);
const names = ['research-assistant', 'release-notes-writer', 'support-triage'];
function item(prefix, i) {
  return {
    id: `${prefix}_0${i + 1}demo`,
    type: prefix,
    name: names[i],
    display_name: names[i],
    label: names[i],
    title: names[i],
    filename: `${names[i]}.md`,
    description: 'Fixture row for the #505 list-surface regression.',
    status: 'active',
    model: 'claude-sonnet-4-6',
    model_id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    created_at: iso(i + 1),
    updated_at: iso(i + 2),
    archived_at: null,
    metadata: {created_by:'Fixture owner'},
    version: i + 1,
    tools: [],
    skills: [],
    mcp_servers: [],
    size_bytes: 2048 * (i + 1),
    mime_type: 'text/markdown',
    config: { type: 'cloud', networking: { type: 'unrestricted' }, packages: {} },
    agent: { id: 'agent_01demo', type: 'agent', version: 1 },
    environment_id: 'environment_01demo',
    usage: { input_tokens: 1200 * (i + 1), output_tokens: 340 * (i + 1) },
    schedule: null,
  };
}
const list = (prefix, n = 3) => Array.from({ length: n }, (_, i) => item(prefix, i));

const runtimes = [0, 1, 2].map((i) => ({
  id: `rt_0${i + 1}`, machine_id: `m_0${i + 1}`, hostname: ['botty', 'build-mac', 'ci-linux'][i],
  os: ['darwin', 'darwin', 'linux'][i], agents: [{ id: 'claude-code', binary: '/usr/local/bin/claude' }],
  local_skills: {}, version: '0.7.3', status: i === 2 ? 'offline' : 'online',
  last_heartbeat: epoch(5), created_at: epoch(i + 1),
}));
const bonds = [0, 1, 2].map((i) => ({
  id: `bond_0${i + 1}`, provider: ['feishu', 'gitlab', 'slack'][i], label: ['Ops bot', 'Review bot', 'Support bot'][i],
  connectedAt: iso(i + 1), running: true, loops: i, details: {}, setup: { ready: true, problems: [] },
}));
const loops = [0, 1, 2].map((i) => ({
  id: `loop_0${i + 1}`, template: 'feishu-agent', provider: bonds[i].provider,
  config: { bond: bonds[i].id, agentId: 'agent_01demo' }, enabled: i !== 2,
  createdAt: iso(i + 1), updatedAt: iso(i + 2), state: { running: i !== 2 },
}));
const apiKeys = [0, 1, 2].map((i) => ({ id: `key_0${i + 1}`, name: names[i], prefix: `oma_${i}abc`, created_at: iso(i + 1), last_used_at: iso(i + 2) }));
const evalRuns = [0, 1, 2].map((i) => ({
  id: `evr_0${i + 1}`, status: ['completed', 'running', 'failed'][i], agent_id: 'agent_01demo', environment_id: 'environment_01demo',
  created_at: iso(i + 1), started_at: iso(i + 1), completed_at: iso(i + 2), score: 0.5 + i * 0.1,
  tasks: [{ id: 't1', status: 'completed', trials: [] }], task_count: 1, completed_count: 1, failed_count: 0,
}));

function page(data) { return { data, next_page: null, has_more: false, last_id: null, next_cursor: null }; }

function fulfill(route) {
  const url = new URL(route.request().url());
  const p = url.pathname;
  const method = route.request().method();
  if (url.origin !== new URL(base).origin) {
    if (url.hostname.includes('fonts.')) return route.fulfill({ contentType: 'text/css', body: '' });
    return route.abort();
  }
  if (p === '/auth/get-session') return route.fulfill({ json: { user: { id: 'demo', name: 'Demo', email: 'demo@example.com', emailVerified: true }, session: { id: 'demo', token: 't', userId: 'demo', expiresAt: '2099-01-01T00:00:00Z' } } });
  if (p === '/v1/oma/me/tenants') return route.fulfill({ json: { data: [{ id: 'demo', name: 'Default', role: 'owner' }] } });
  if (method !== 'GET' && (p.startsWith('/v1/') || p.startsWith('/matter'))) return route.fulfill({ json: {} });
  if (p === '/v1/oma/runtimes') return route.fulfill({ json: { runtimes } });
  if (p === '/v1/oma/api_keys') return route.fulfill({ json: page(apiKeys) });
  if (p === '/v1/oma/evals/runs') return route.fulfill({ json: page(evalRuns) });
  if (p === '/matter/bonds') return route.fulfill({ json: { data: bonds } });
  if (p === '/matter/loops') return route.fulfill({ json: { data: loops } });
  if (p.startsWith('/matter')) return route.fulfill({ json: { data: [] } });
  if (p === '/v1/vaults/vault_01demo') return route.fulfill({json: item('vault',0)});
  if (p === '/v1/vaults/vault_01demo/credentials') return route.fulfill({json: page([{...item('vault_credential',0),auth:{type:'static_bearer',mcp_server_url:'https://example.test/mcp'}}])});
  if (p === '/v1/agents/agent_01demo') return route.fulfill({json:{...item('agent',0),system:'Fixture system prompt'}});
  if (p === '/v1/oma/harnesses') return route.fulfill({json:{default_harness_id:'default',data:[{id:'default',label:'Default',execution:{placement:'host'},capabilities:{runtime_binding:false},requirements:[]}]}});
  if (p.startsWith('/linear') || p.startsWith('/github')) return route.fulfill({json:page([])});
  const m = p.match(/^\/v1\/(?:oma\/)?([a-z_]+)$/);
  if (m) return route.fulfill({ json: page(list(m[1].replace(/s$/, '')).filter(it=>!url.searchParams.get('q') || JSON.stringify(it).toLowerCase().includes(url.searchParams.get('q').toLowerCase()))) });
  if (p.startsWith('/v1/') || p.startsWith('/auth') || p === '/auth-info' || p.startsWith('/branding') || p === '/health') {
    return route.fulfill({ json: page([]) });
  }
  return route.continue();
}


return fulfill;
}
