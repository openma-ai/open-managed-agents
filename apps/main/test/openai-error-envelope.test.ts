import { describe, expect, it } from 'vitest';
import { normalizeOpenAIAgentsErrorResponse, OpenAIAgentsProtocolError, buildOpenAIAgentsProtocolApi } from '@open-managed-agents/openai-agents-api';
import { Hono } from 'hono';
import { cfSessionCreateAdmission } from '../src/lib/cf-session-create-admission';

// The same normalizer is mounted by apps/main and the Node control plane.
// Exercise it in workerd, including the real CF admission classification.
describe('CF OpenAI error envelopes', () => {
  it.each([
    [403, 'model_not_found', 'agent.model', 'Model unavailable to this project'],
    [429, 'credit_balance_exhausted', undefined, 'No balance left'],
    [429, 'organization_usage_limit_exceeded', undefined, 'Daily usage exhausted'],
    [429, 'rate_limit_exceeded', undefined, 'Requests per minute exceeded'],
  ] as const)('preserves classified %s %s errors and headers', async (status, code, param, message) => {
    const app = new Hono();
    app.use('*', async (c, next) => { await next(); c.res.headers.set('retry-after', '30'); c.res = await normalizeOpenAIAgentsErrorResponse(c.res); });
    app.route('/', buildOpenAIAgentsProtocolApi({ execute: async () => { throw new OpenAIAgentsProtocolError(status, message, param, code); } }));
    const response = await app.request('/v1/agents/sessions/s', { headers: { 'OpenAI-Beta': 'agents=v1' } });
    expect(response.status).toBe(status);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(await response.json()).toMatchObject({ error: { code, message, param: param ?? null } });
  });
  it.each([[401, 'invalid_api_key'], [403, 'insufficient_permissions'], [429, 'rate_limit_exceeded']] as const)('wraps unstructured middleware %s without losing its message', async (status, code) => {
    const response = await normalizeOpenAIAgentsErrorResponse(new Response(JSON.stringify({ error: 'Middleware reason' }), { status, headers: { 'retry-after': '2' } }));
    expect(await response.json()).toMatchObject({ error: { code, param: null, message: 'Middleware reason' } });
    expect(response.headers.get('retry-after')).toBe('2');
  });
  it('keeps daily quota distinct from a CF per-minute rate limiter refusal', async () => {
    const input = { workspaceId: 'w', agentId: 'a', environmentId: 'env', isLocalRuntime: true };
    const kv = { get: async () => '1', put: async () => {} } as never;
    const quota = await cfSessionCreateAdmission({ SESSION_DAILY_CAP_PER_TENANT: '1' } as never, kv).admit(input);
    expect(quota).toMatchObject({ type: 'rate_limited', reason: 'daily_quota' });
    const rate = await cfSessionCreateAdmission({ RL_SESSIONS_TENANT: { limit: async () => ({ success: false }) } } as never, kv).admit(input);
    expect(rate.type).toBe('rate_limited');
    expect(rate).not.toHaveProperty('reason', 'daily_quota');
  });
});
