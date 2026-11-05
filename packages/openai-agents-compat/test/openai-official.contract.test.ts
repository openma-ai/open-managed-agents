import { describe, expect, it } from 'vitest';
import { buildOpenAIAgentsProtocolApi, OpenAIAgentsProtocolError } from '../../openai-agents-api/src/index';
import { createSessionsHandler, type SessionSemanticDependencies } from '../src/sessions';
import { createManagedSessionMapping } from '../src/session-mapping';
import { normalizeAgentConfig } from '../src/resources';
import { createArtifactsHandler, publishSessionArtifact } from '../src/artifacts';
import { resourcesFixture } from './helpers/resources';
import { applyManagedEvents, createProjectionState } from '../src/projection';
import { createAuthMiddleware } from '../../auth/src/index';
import { buildNodeOpenAIAgentsRoutes } from '../../control-plane-node/src/openai-agents';

/** Source index (fetched 2026-11-04):
 * OpenAPI: https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml
 * Cached full spec: /tmp/oma-523-openapi-raw.txt; /tmp/oma-523-openapi-sessions.yaml.
 * Official rendered HTTP reference:
 * root = https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/
 * S = root + methods/create.md; L = root + methods/list.md;
 * D = root + methods/delete.md; E = root + subresources/events/methods/create.md.
 * A = root + subresources/artifacts/methods/{list,retrieve,delete,content}.md.
 * Tn = /tmp/oai-plugins/plugins/openai-developers/skills/openai-api-troubleshooting/references/evals.md.
 * B = /tmp/oma-523-oai/log-luna.jsonl (gpt-6-luna only).
 * These are HTTP tests through the full router + real compat handlers/mapping.
 * Storage/admission/executor are boundary doubles, never a mock HTTP response.
 * T1/T2 require client network/escalation, and are deliberately not simulated here.
 */
const beta = { 'OpenAI-Beta': 'agents=v1', 'Content-Type': 'application/json' };
const valid = { agent: { model: 'test' }, environment: { type: 'none' }, input: 'hello' };
const message = (text = 'next') => ({ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] });
const cancel = { type: 'agent.session.input.cancel' };
const user = (id: string) => ({ id, type: 'user.message', content: [{ type: 'text', text: id }] });
const running = { id: 'run', type: 'session.status_running' };
const ended = { id: 'end', type: 'session.status_idle', stopReason: { type: 'end_turn' } };

function fixture() {
  const r = resourcesFixture();
  const native: any = { id: 's', agent: { id: 'agent' }, environmentId: 'env', metadata: {}, createdAt: new Date(100000).toISOString(), updatedAt: new Date(101000).toISOString() };
  const facts: any[] = [user('A'), running, ended];
  const sent: any[] = [];
  const deletes: string[] = [];
  const prepared: any[] = [];
  let admission: any = null;
  let legacy = false;
  // Runtime here supplies environment execution only, no model registry. T6 below
  // tests the protocol's classification of an actual model access error instead
  // of pretending a permissive executor can prove model availability checks.
  const mapping = createManagedSessionMapping({ agents: r.agents, environments: r.environments, resources: r.handler, secrets: r.secrets,
    runtime: { prepareEnvironment: async config => { prepared.push(config); return { environmentId: 'env' }; }, environmentView: async () => ({ type: 'none' }) } });
  const deps: SessionSemanticDependencies = {
    workspaceId: 'workspace_a',
    sessions: {
      createSession: async command => { if (admission) return admission; Object.assign(native, { metadata: command.metadata, environmentId: command.environmentId }); return { type: 'created', session: native }; },
      retrieveSession: async ({ sessionId }) => ['s', 'other'].includes(sessionId) ? { type: 'found', session: { ...native, id: sessionId } } : { type: 'not_found' },
      updateSession: async () => ({ type: 'updated', session: native }),
      listSessions: async () => ({ type: 'page', page: { sessions: [native], nextCursor: null, previousCursor: null } }),
      deleteSession: async ({ sessionId }) => { deletes.push(sessionId); return { type: 'deleted', sessionId }; },
      archiveSession: async () => ({ type: 'not_found' }),
    },
    sessionEvents: {
      sendSessionEvents: async command => { sent.push(command); return { type: 'accepted', events: [] }; },
      listSessionEvents: async () => ({ type: 'not_found' }), streamSessionEvents: async () => ({ type: 'not_found' }),
    },
    history: { loadSessionRuntimeHistory: async () => ({ type: 'found', revision: 1, initialEvents: [], events: facts,
      ...(!legacy && { orderedEvents: facts.map((event, index) => ({ event, position: { revision: 1, index } })) }) }) },
    mapping: {
      prepareCreate: mapping.prepareCreate,
      prepareMetadata: mapping.prepareMetadata,
      sessionView: async session => {
        const { metadata: _metadata, ...agent } = normalizeAgentConfig({ model: 'test' });
        return { id: session.id, object: 'agent.session', created_at: 100, last_active_at: 101, agent: { ...agent, id: 'agent' }, environment: { type: 'none' }, status: 'idle', error: null, metadata: {}, required_actions: [], usage: null, vault_ids: [] } as any;
      },
    }, pollMs: 1,
    resources: { execute: createArtifactsHandler({ files: r.files, requireSession: async id => { if (!['s', 'other'].includes(id)) throw new OpenAIAgentsProtocolError(404, 'Session not found'); } }) },
  };
  const app = buildOpenAIAgentsProtocolApi(createSessionsHandler(deps));
  const request = (path = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(`/v1/agents/sessions${path}`, {
    method, headers: { ...beta, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const pending = () => {
    facts.splice(0, facts.length, user('A'), running, { id: 'call', type: 'agent.custom_tool_use', name: 'lookup', input: {} },
      { id: 'wait', type: 'session.status_idle', stopReason: { type: 'requires_action', eventIds: ['call'] } });
    return { type: 'agent.session.input.tool_result', turn_id: 'turn_s:root:A', call_id: 'call', success: true, output: 'XYZZY' };
  };
  return { ...r, facts, sent, deletes, prepared, deps, app, request, pending, admission: (value: any) => { admission = value; }, legacy: () => { legacy = true; } };
}
function mounted(execute: () => Promise<never>) {
  const auth = createAuthMiddleware({ disabled: false, resolveSession: async () => null,
    resolveApiKey: async key => key === 'valid' ? { tenantId: 'workspace_a', credential: { type: 'workspace' } } : null,
    defaultTenantForUser: async () => null, hasMembership: async () => false,
    ensureTenantForUser: async () => { throw new Error('Unexpected interactive authentication'); } });
  return buildNodeOpenAIAgentsRoutes({ authMiddleware: auth, portFor: () => ({ execute }) });
}
async function error(response: Response, status: number, fields: Record<string, unknown>) {
  expect(response.status).toBe(status);
  expect(await response.json<any>()).toMatchObject({ error: fields });
}

describe('official Sessions contract: supported', () => {
  // C01: S agent.model is required without agent_id.
  it('C01 missing model identifies agent.model', async () => {
    await error(await fixture().request('', 'POST', { ...valid, agent: {} }), 400, { type: 'invalid_request_error', param: 'agent.model' });
  });
  // C02: S agent_id may replace inline agent/model (successful status range only; C10 pins 201).
  it('C02 saved agent may omit inline model', async () => {
    const f = fixture(); const agent = await f.run('agents.create', { model: 'test' });
    const response = await f.request('', 'POST', { environment: { type: 'none' }, input: 'hi', agent_id: agent.id });
    expect(response.ok).toBe(true);
  });
  // C03: S agent_id resource reference; error-codes guide resource not found.
  it('C03 missing saved agent returns resource_not_found', async () => {
    await error(await fixture().request('', 'POST', { ...valid, agent_id: 'missing' }), 404, { code: 'resource_not_found', param: 'agent_id' });
  });
  // C04: S input required for environment.type=none.
  it('C04 none requires initial input', async () => {
    const { input: _input, ...body } = valid;
    await error(await fixture().request('', 'POST', body), 400, { param: 'input' });
  });
  // C06/C07: S EnvironmentParam self_hosted.workspace_directory required; type enum.
  it.each([
    ['C06', { type: 'self_hosted' }], ['C07', { type: 'future' }],
  ])('%s rejects invalid environment before native creation', async (_id, environment) => {
    const f = fixture(); let creates = 0;
    f.deps.sessions.createSession = async () => { creates++; throw new Error('must not create'); };
    expect((await f.request('', 'POST', { ...valid, environment })).status).toBe(400);
    expect(creates).toBe(0);
  });
  // C08: S input[].content[].input_image.image_url; malformed image URL is invalid input.
  it('C08 rejects invalid image input URL', async () => {
    await error(await fixture().request('', 'POST', { ...valid, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'not a URL' }] }] }), 400, { param: 'input' });
  });
  // C09: S metadata: <=16 entries, key <=64 chars, value <=512 chars.
  it.each([
    ['C09-count', Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']))],
    ['C09-key', { ['k'.repeat(65)]: 'v' }], ['C09-value', { k: 'v'.repeat(513) }],
  ])('%s enforces metadata bounds', async (_id, metadata) => {
    const response = await fixture().request('', 'POST', { ...valid, metadata });
    expect(response.status).toBe(400);
    expect((await response.json<any>()).error.param).toMatch(/^metadata(?:\.|$)/);
  });
  // C11: E description + 202 example; B line 184 cancel also returns empty 202.
  it.each([['C11-message', message()], ['C11-cancel', cancel]])('%s returns empty 202', async (_id, event) => {
    const response = await fixture().request('/s/events', 'POST', { events: [event] });
    expect(response.status).toBe(202); expect(await response.text()).toBe('');
  });
  // C11-boundary: boundary/results.jsonl line 5 (off=2000) and line 9
  // (steer then off=3500): a follow-up near turn completion is accepted, never 409.
  it('C11-boundary running follow-up is accepted with 202', async () => {
    const f = fixture(); f.facts.splice(2);
    const response = await f.request('/s/events', 'POST', { events: [message('B2000')] });
    expect(response.status).toBe(202); expect(await response.text()).toBe('');
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].events).toMatchObject([{ type: 'user.message', content: [{ type: 'text', text: 'B2000' }] }]);
  });
  // C13/C14: E tool_result.turn_id and call_id identify a pending function call.
  it('C13 foreign turn result is rejected without dispatch', async () => {
    const f = fixture(), result = f.pending();
    const response = await f.request('/s/events', 'POST', { events: [{ ...result, turn_id: 'foreign' }] });
    expect(response.status).toBe(400);
    expect(['turn_id', 'call_id']).toContain((await response.json<any>()).error.param);
    expect(f.sent).toHaveLength(0);
  });
  it('C14 duplicate function result in one batch is rejected atomically', async () => {
    const f = fixture(), result = f.pending();
    await error(await f.request('/s/events', 'POST', { events: [result, result] }), 400, { param: 'call_id' });
    expect(f.sent).toHaveLength(0);
  });
  // C16: B L2_req1 waiting; baseline §3 tool_result preserves turn; owner #4.
  it('C16 message while waiting is accepted and does not replace required actions', async () => {
    const f = fixture(); f.pending();
    const before = await (await f.request('/s')).json<any>();
    expect((await f.request('/s/events', 'POST', { events: [message()], }, { 'Idempotency-Key': 'C16-unique' })).status).toBe(202);
    expect((await (await f.request('/s')).json<any>()).required_actions).toEqual(before.required_actions);
    expect(f.sent).toHaveLength(0);
    // Drain the process-local staged message to avoid state shared with other tests.
    await f.request('/s/events', 'POST', { events: [cancel] });
  });
  // C17-valid: E header bounds inclusive 1..256; same key retries preserve native identity.
  // Durable exactly-once acceptance is covered by sessions-sql-sdk.test.ts (real SQL).
  it.each([['C17-one', 'k'], ['C17-max', 'k'.repeat(256)]])('%s preserves retry identity', async (_id, key) => {
    const f = fixture();
    for (let i = 0; i < 2; i++) expect((await f.request('/s/events', 'POST', { events: [message()] }, { 'Idempotency-Key': key })).status).toBe(202);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0].idempotencyKey).toBe(key);
    expect(f.sent[1].events).toEqual(f.sent[0].events);
  });
  // C09-edge: S metadata bounds are inclusive.
  it('C09-edge accepts sixteen pairs and maximum key/value lengths', async () => {
    const metadata = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String(i).padEnd(64, 'k'), 'v'.repeat(512)]));
    expect((await fixture().request('', 'POST', { ...valid, metadata })).ok).toBe(true);
  });
  // C18-edge: L limit bounds inclusive.
  it.each([1, 100])('C18-edge accepts limit=%s', async limit => {
    expect((await fixture().request(`?limit=${limit}`)).status).toBe(200);
  });
  // C09-archived: S agent_id must identify a usable saved agent (C03 counterpart).
  it('C03-archived refuses an archived saved agent', async () => {
    const f = fixture(); const agent = await f.run('agents.create', { model: 'test' });
    await f.agents.archiveAgent({ agentId: agent.id });
    await error(await f.request('', 'POST', { ...valid, agent_id: agent.id }), 404, { param: 'agent_id', code: 'resource_not_found' });
  });
  // C18-min/order: L limit integer 1..100, order asc|desc.
  it.each([['C18-zero', 'limit=0'], ['C18-fraction', 'limit=1.5'], ['C18-order', 'order=sideways']])('%s rejects invalid query', async (_id, query) => {
    expect((await fixture().request(`?${query}`)).status).toBe(400);
  });
  // C19: L after must address an ID in the selected collection; also turns/items list after.
  it.each(['', '/s/turns', '/s/items', '/s/artifacts'])('C19 foreign cursor %s', async path => {
    await error(await fixture().request(`${path}?after=foreign`), 400, { param: 'after' });
  });
  // C22: GET /sessions/{id}, /turns/{turn_id}, /subagents/{subagent_id}: missing resource.
  it.each(['/missing', '/s/turns/missing', '/s/subagents/missing', '/s/subagents/missing/items'])('C22 missing resource %s', async path => {
    await error(await fixture().request(path), 404, { type: 'invalid_request_error', code: 'resource_not_found' });
  });
  // C24: E defines explicit input.cancel; closing GET events stream is only unsubscribe.
  it('C24 disconnect does not submit a cancel input', async () => {
    const f = fixture(); f.facts.splice(2);
    const abort = new AbortController();
    const response = await f.app.fetch(new Request('http://test/v1/agents/sessions/s/events', { headers: beta, signal: abort.signal }));
    const reader = response.body!.getReader();
    const first = reader.read(); abort.abort(); await first; await reader.cancel();
    expect(f.sent).toHaveLength(0);
    expect((await (await f.request('/s')).json<any>()).status).toBe('in_progress');
  });
  // C25: official AgentSessionErrorEvent error envelope (SDK 7.15 schema, sessions events stream).
  it('C25 stream error preserves scope without exposing backend exception', async () => {
    const app = buildOpenAIAgentsProtocolApi({ execute: async () => ({ stream: (async function* () { throw new Error('secret diagnostic'); })() }) });
    const response = await app.request('/v1/agents/sessions/s/events', { headers: beta });
    const frames = await response.text();
    const data = JSON.parse(frames.split('\n').find(line => line.startsWith('data:'))!.slice(5));
    expect(data).toMatchObject({ type: 'error', session_id: 's', event_id: expect.any(String), error: { type: 'server_error', message: expect.any(String), code: expect.any(String), param: null } });
    expect(frames).not.toContain('secret diagnostic');
  });
  // C25-unscoped: OpenAPI ErrorResponse-2; create stream can fail before an ID exists.
  it('C25-unscoped creation stream failure does not invent session identity', async () => {
    const app = buildOpenAIAgentsProtocolApi({ execute: async () => ({ stream: (async function* () { throw new Error('secret diagnostic'); })() }) });
    const response = await app.request('/v1/agents/sessions', { method: 'POST', headers: beta, body: JSON.stringify({ ...valid, stream: true }) });
    const frames = await response.text();
    const data = JSON.parse(frames.split('\n').find(line => line.startsWith('data:'))!.slice(5));
    expect(data).toMatchObject({ error: { type: 'server_error', message: expect.any(String) } });
    expect(data).not.toHaveProperty('session_id'); expect(frames).not.toContain('secret diagnostic');
  });
  // C29-idle: D 200 deletion confirmation with object and deleted:true.
  it('C29-idle deletes an idle session', async () => {
    const response = await fixture().request('/s', 'DELETE');
    expect(response.status).toBe(200);
    expect(await response.json<any>()).toEqual({ id: 's', object: 'agent.session.deleted', deleted: true });
  });
  // C30: S example requires OpenAI-Beta: agents=v1.
  it.each(['', 'agents=wrong'])('C30 rejects beta header %j', async value => {
    await error(await fixture().request('/s', 'GET', undefined, { 'OpenAI-Beta': value }), 400, { param: 'OpenAI-Beta', type: 'invalid_request_error' });
  });
  // C21-setup: S OpenAIHosted.setup_commands[] SetupCommandParam.command.
  // Assert delivery to the executor boundary; no claim about actually running commands.
  it('C21-setup preserves hosted setup_commands for the executor', async () => {
    const f = fixture(), setup_commands = [{ command: 'echo ready' }];
    expect((await f.request('', 'POST', { ...valid, environment: { type: 'openai_hosted', setup_commands } })).ok).toBe(true);
    expect(f.prepared.at(-1)).toMatchObject({ setup_commands });
  });

});

describe('official Sessions contract: contract-gap', () => {
  // C05 contract-gap: S input required when stream=true and environment is not self_hosted.
  it('C05 hosted streaming creation requires input', async () => {
    const response = await fixture().request('', 'POST', { agent: { model: 'test' }, environment: { type: 'openai_hosted' }, stream: true });
    // Cancel subscription so a failed assertion never leaves a poll loop running.
    await response.body?.cancel();
    expect(response.status).toBe(400);
  });
  // C09-emptykey contract-gap: OpenAPI CreateSessionParams.metadata.propertyNames.minLength=1.
  it('C09-emptykey refuses an empty metadata key', async () => {
    expect((await fixture().request('', 'POST', { ...valid, metadata: { '': 'value' } })).status).toBe(400);
  });
  // C10 contract-gap: S HTTP response example explicitly 201.
  it('C10 creation returns 201', async () => {
    expect((await fixture().request('', 'POST', valid)).status).toBe(201);
  });
  // C17 contract-gap: E Idempotency-Key minLength=1,maxLength=256.
  it.each([['C17-empty', ''], ['C17-long', 'x'.repeat(257)]])('%s rejects invalid Idempotency-Key length', async (_id, key) => {
    const f = fixture();
    expect((await f.request('/s/events', 'POST', { events: [message()] }, { 'Idempotency-Key': key })).status).toBe(400);
    expect(f.sent).toHaveLength(0);
  });
  // C18-max contract-gap: L limit maximum=100.
  it('C18-max list rejects limit=101', async () => {
    await error(await fixture().request('?limit=101'), 400, { param: 'limit' });
  });
  // C20 contract-gap: L first_id/last_id/object; empty page endpoints are null.
  it.each([['C20-one', false], ['C20-empty', true]])('%s list has the official envelope', async (_id, empty) => {
    const f = fixture(); if (empty) f.deps.sessions.listSessions = async () => ({ type: 'page', page: { sessions: [], nextCursor: null, previousCursor: null } });
    const response = await f.request(); expect(response.status).toBe(200);
    expect(await response.json<any>()).toMatchObject({ object: 'list', first_id: empty ? null : 's', last_id: empty ? null : 's', has_more: false });
  });
  // C21-filter contract-gap: L metadata[key] exact matches, all pairs must match.
  it('C21-filter accepts metadata filter and excludes nonmatching sessions', async () => {
    const response = await fixture().request('?metadata[purpose]=missing');
    expect(response.status).toBe(200); expect((await response.json<any>()).data).toEqual([]);
  });
  // C21-review contract-gap: S review enum includes none (default); no auto-review execution claim.
  it.each(['none', 'auto_review'])('C21-review accepts explicit review %s', async review => {
    expect((await fixture().request('', 'POST', { ...valid, review })).ok).toBe(true);
  });
  // C21-size contract-gap: S environment.openai_hosted.container_size includes small.
  it('C21-size accepts hosted container_size', async () => {
    expect((await fixture().request('', 'POST', { ...valid, environment: { type: 'openai_hosted', container_size: 'small' } })).ok).toBe(true);
  });
  // C20-collections contract-gap: corresponding OpenAPI list response schemas
  // for turns/items/subagents/artifacts all require object, first_id and last_id.
  it.each(['/s/turns', '/s/items', '/s/subagents', '/s/artifacts'])('C20-collections %s uses the official envelope', async path => {
    const response = await fixture().request(path); expect(response.status).toBe(200);
    const page = await response.json<any>();
    expect(page).toMatchObject({ object: 'list', first_id: page.data[0]?.id ?? null, last_id: page.data.at(-1)?.id ?? null });
  });
  // C12 contract-gap: OpenAPI components.schemas.CreateSessionEventsParams.events
  // minItems=0 (the earlier analysis incorrectly assumed >=1). This tests schema
  // acceptance on a missing session, without guessing empty-batch no-op semantics.
  it('C12 empty events passes schema validation before session lookup', async () => {
    await error(await fixture().request('/missing/events', 'POST', { events: [] }), 404, { code: 'resource_not_found' });
  });
  // C12-max contract-gap: same OpenAPI field maxItems=16384.
  it('C12-max rejects more than 16384 events before dispatch', async () => {
    let reached = false;
    // Validate the request boundary without projecting 16k messages on today's
    // permissive path (that would turn a bounds test into a quadratic stress test).
    const app = buildOpenAIAgentsProtocolApi({ execute: async () => { reached = true; return { status: 202 }; } });
    const response = await app.request('/v1/agents/sessions/s/events', { method: 'POST', headers: beta,
      body: JSON.stringify({ events: Array.from({ length: 16385 }, () => message()) }) });
    expect(response.status).toBe(400); expect(reached).toBe(false);
  });
  // C21-computer contract-gap: OpenAPI SessionInputParam discriminator includes
  // computer_use_approval_request_result; exercise request validation only.
  it('C21-computer accepts the documented computer approval input union member', async () => {
    const event = { type: 'agent.session.input.computer_use_approval_request_result', request_id: 'req', response: { type: 'browser_authentication', action: 'cancel' } };
    let reached = false;
    const app = buildOpenAIAgentsProtocolApi({ execute: async ({ body }) => {
      reached = true; expect(body).toEqual({ events: [event] });
      throw new OpenAIAgentsProtocolError(404, 'Missing session');
    } });
    const response = await app.request('/v1/agents/sessions/missing/events', { method: 'POST', headers: beta, body: JSON.stringify({ events: [event] }) });
    expect(response.status).toBe(404); expect(reached).toBe(true);
  });
  // C29-running contract-gap: D "Running execution must be cancelled first".
  // No status/code is specified: assert rejection and no deletion, NOT a guessed 409.
  it('C29-running rejects deletion until running execution is cancelled', async () => {
    const f = fixture(); f.facts.splice(2);
    const response = await f.request('/s', 'DELETE');
    expect(response.ok).toBe(false); expect(f.deletes).toEqual([]);
  });
});

describe('official troubleshooting checker (supported + contract-gap)', () => {
  // T3-mounted: evals.md T3, invalid/missing key -> 401 invalid_api_key.
  it.each(['', 'Bearer bad'])('T3-mounted sessions authentication %j', async authorization => {
    let executed = false;
    const app = mounted(async () => { executed = true; throw new Error('must not execute'); });
    await error(await app.request('/v1/agents/sessions/s', { headers: { ...beta, Authorization: authorization } }), 401,
      { type: 'authentication_error', code: 'invalid_api_key', param: null });
    expect(executed).toBe(false);
  });
  // T6-mounted contract-gap: evals.md T6. A model access error already has an
  // upstream model_not_found code; the outer auth wrapper must not replace it.
  it('T6-mounted preserves upstream model_not_found across Node auth wrapping', async () => {
    const app = mounted(async () => { throw new OpenAIAgentsProtocolError(403, 'Model unavailable to this project', 'agent.model', 'model_not_found'); });
    await error(await app.request('/v1/agents/sessions/s', { headers: { ...beta, Authorization: 'Bearer valid' } }), 403,
      { code: 'model_not_found', param: 'agent.model', message: 'Model unavailable to this project' });
  });
  // T3: evals.md authentication failure; test generic protocol fallback, outer auth wrappers separately covered.
  // T3 contract-gap: full router currently defaults 401 code to invalid_request.
  it('T3 authentication fallback uses invalid_api_key', async () => {
    const app = buildOpenAIAgentsProtocolApi({ execute: async () => { throw new OpenAIAgentsProtocolError(401, 'Invalid API key'); } });
    await error(await app.request('/v1/agents/sessions/s', { headers: beta }), 401, { type: 'authentication_error', code: 'invalid_api_key', param: null });
  });
  // T4 contract-gap: evals.md T4 + SKILL.md distinguish credits from transient rate limit.
  // Error-codes guide 429 Credit balance exhausted explicitly specifies credit_balance_exhausted.
  it('T4 exhausted credits are quota exhaustion rather than invalid request', async () => {
    const f = fixture(); f.admission({ type: 'payment_required', message: 'No balance left' });
    const response = await f.request('', 'POST', valid);
    expect(response.status).toBe(429);
    const { error: body } = await response.json<any>();
    expect(body.code).toBe('credit_balance_exhausted');
    expect(body.code).not.toBe('rate_limit_exceeded');
  });
  // T5 contract-gap: evals.md T5 explicitly 429 rate_limit_exceeded.
  it('T5 admission rate limit uses rate_limit_exceeded', async () => {
    const f = fixture(); f.admission({ type: 'rate_limited', message: 'Requests per minute exceeded' });
    await error(await f.request('', 'POST', valid), 429, { type: 'rate_limit_error', code: 'rate_limit_exceeded' });
  });
  // T6: evals.md T6 uses 403 model_not_found, an access failure.
  // Preserve upstream classification; generic 403 must NOT guess a model error from prose.
  it('T6 model access failure retains model_not_found classification', async () => {
    const app = buildOpenAIAgentsProtocolApi({ execute: async () => { throw new OpenAIAgentsProtocolError(403, 'Model does not exist or you do not have access', 'agent.model', 'model_not_found'); } });
    await error(await app.request('/v1/agents/sessions/s', { headers: beta }), 403, { code: 'model_not_found', param: 'agent.model' });
  });
  // T4/T5 turn level: official SessionTurnError.code enum (SDK/HTTP turn schema).
  it.each([['T4-turn', 'billing_error', 'usage_limit_exceeded'], ['T5-turn', 'model_rate_limited_error', 'rate_limit_exceeded']])('%s keeps turn quota and rate limit codes distinct', (_id, type, code) => {
    const result = applyManagedEvents(createProjectionState({ sessionId: 's', agentId: 'a', createdAt: 1 }), [user('A'), running,
      { id: 'error', type: 'session.error', error: { type, message: 'upstream failure', retry_status: 'terminal' } }], { observedAt: 1 });
    expect(result.state.turns[result.state.turnOrder[0]!]).toMatchObject({ status: 'failed', error: { code } });
  });
});

describe('official artifact contract', () => {
  async function artifactFixture() {
    const f = fixture();
    const publish = (environmentId: string, path: string) => publishSessionArtifact({ files: f.files, requireCompletedTurn: async () => {} }, {
      sessionId: 's', environmentId, turnId: 'turn_s:root:A', path, mimeType: 'application/octet-stream', content: new Uint8Array([0, 255, 42]),
    });
    return { ...f, artifact: await publish('env1', '/workspace/outputs/one.bin'), second: await publish('env2', '/workspace/outputs/two.bin') };
  }
  // C26: A list environment_id + order/after/limit; resources remain scoped to session.
  it('C26 artifact environment filter and pagination', async () => {
    const f = await artifactFixture();
    const page = await (await f.request('/s/artifacts?environment_id=env1&order=asc&limit=1')).json<any>();
    expect(page.data.map((x: any) => x.id)).toEqual([f.artifact.id]); expect(page.has_more).toBe(false);
    const all = await (await f.request('/s/artifacts?order=asc&limit=1')).json<any>();
    expect(all.has_more).toBe(true);
    expect((await (await f.request(`/s/artifacts?order=asc&after=${f.artifact.id}`)).json<any>()).data.map((x: any) => x.id)).toEqual([f.second.id]);
  });
  // C27: A retrieve/content/delete missing or cross-session artifact is a missing resource.
  it.each(['missing', 'foreign', 'deleted'])('C27 %s artifact is resource_not_found', async kind => {
    const f = await artifactFixture();
    if (kind === 'deleted') await f.request(`/s/artifacts/${f.artifact.id}`, 'DELETE');
    const path = kind === 'missing' ? '/s/artifacts/nope' : `/${kind === 'foreign' ? 'other' : 's'}/artifacts/${f.artifact.id}`;
    await error(await f.request(path), 404, { code: 'resource_not_found' });
  });
  // C28: A content application/octet-stream, bytes unchanged; A delete object discriminator.
  it('C28 artifact content bytes and deletion confirmation', async () => {
    const f = await artifactFixture();
    const response = await f.request(`/s/artifacts/${f.artifact.id}/content`);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 42]);
    expect(await (await f.request(`/s/artifacts/${f.artifact.id}`, 'DELETE')).json<any>()).toEqual({ id: f.artifact.id, object: 'agent.session.artifact.deleted', deleted: true });
  });
});
