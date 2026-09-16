import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLiveConfig, redactSecrets } from './backchat-live-config.mjs';
const input = () => ({
  baseUrl: 'http://127.0.0.1:18877', tokenEnv: 'OMA_TEST_TOKEN', tenantId: 'tenant-live',
  user: { id: 'user-live', email: 'test@localhost.test' }, tenantName: 'Test tenant',
  model: 'deepseek-flash', backchatDir: '/tmp/backchat',
  acp: { id: 'dsh-acp', command: 'dsh-acp', args: ['--model', '{model}'], env: { DEEPSEEK_API_KEY: { fromEnv: 'DEEPSEEK_API_KEY' }, DSH_HOME: '{workspace}/.dsh' } },
});
const env = { OMA_TEST_TOKEN: 'test-workspace-key', DEEPSEEK_API_KEY: 'test-provider-secret' };
test('requires explicit model and ACP command without falling back to Codex', () => {
  for (const field of ['model', 'acp']) { const c = input(); delete c[field]; assert.throws(() => resolveLiveConfig(c, env)); }
  const c = input(); delete c.acp.command; assert.throws(() => resolveLiveConfig(c, env));
});
test('resolves model, isolated workspace and named secret references', () => {
  const c = resolveLiveConfig(input(), env);
  assert.equal(c.token, env.OMA_TEST_TOKEN);
  assert.deepEqual(c.agent('/tmp/session').args, ['--model', 'deepseek-flash']);
  assert.deepEqual(c.agent('/tmp/session').env, { DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY, DSH_HOME: '/tmp/session/.dsh' });
});
test('fails on missing credentials before any side effects', () => {
  assert.throws(() => resolveLiveConfig(input(), {}), /OMA_TEST_TOKEN/);
  assert.throws(() => resolveLiveConfig(input(), { OMA_TEST_TOKEN: 'key' }), /DEEPSEEK_API_KEY/);
});
test('requires model to be wired into actual ACP invocation', () => {
  const c = input(); c.acp.args = []; assert.throws(() => resolveLiveConfig(c, env), /model/);
});
test('validates endpoint and bounded timeout', () => {
  for (const baseUrl of ['file:///etc/passwd', 'https://user:secret@example.com', 'not-a-url']) {
    assert.throws(() => resolveLiveConfig({ ...input(), baseUrl }, env));
  }
  assert.throws(() => resolveLiveConfig({ ...input(), timeoutMs: 0 }, env));
});
test('redacts workspace and provider credentials from diagnostic output', () => {
  const c = resolveLiveConfig(input(), env);
  assert.equal(redactSecrets('test-workspace-key/test-provider-secret', c.secrets), '<redacted>/<redacted>');
});
