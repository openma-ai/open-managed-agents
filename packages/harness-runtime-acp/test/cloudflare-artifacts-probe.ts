/** Bundled by the Cloudflare live suite and uploaded at runtime, never baked into its image. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolveAcpRelease, resolveBinaryAcpRelease, prepareAcpRelease } from '@openma/common/acp-artifacts';
import { AcpRuntimeImpl } from '@open-managed-agents/acp-runtime';
import { NodeSpawner } from '@open-managed-agents/acp-runtime/node-spawner';
process.env.NODE_ENV = 'test';
const exec = promisify(execFile);
const root = '/tmp/openma-cf-artifacts';
const steps: Record<string, unknown>[] = [];
async function step(name: string, fn: () => Promise<Record<string, unknown>>) {
  const start = Date.now();
  steps.push({ name, ...await fn(), duration_ms: Date.now() - start });
  console.log(JSON.stringify({ step: steps.at(-1) }));
}
await mkdir('/workspace/certification-codex', { recursive: true });
await step('binary', async () => {
  assert.equal(process.platform, 'linux');
  const target = process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  const archive = `https://github.com/astral-sh/uv/releases/download/0.10.9/uv-${target}.tar.gz`;
  const response = await fetch(`${archive}.sha256`);
  assert.equal(response.ok, true);
  const sha256 = (await response.text()).trim().split(/\s+/)[0]!;
  const release = resolveBinaryAcpRelease({ id: 'uv', version: '0.10.9', platform: `linux-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`, archive, sha256, command: `uv-${target}/uv` });
  const prepared = await prepareAcpRelease(release, { root });
  const { stdout } = await exec(prepared.command, ['--version']);
  assert.match(stdout, /^uv 0\.10\.9/);
  process.env.PATH = `${dirname(prepared.command)}:${process.env.PATH}`;
  return { version: stdout.trim(), digest: release.digest };
});
await step('uvx', async () => {
  const release = await resolveAcpRelease({ id: 'ruff', version: '0.11.0' }, { type: 'uvx', package: 'ruff' });
  const prepared = await prepareAcpRelease(release, { root });
  const { stdout } = await exec(prepared.command, ['--version']);
  assert.equal(stdout.trim(), 'ruff 0.11.0');
  const cached = await prepareAcpRelease(release, { root, fetch: async () => { throw new Error('network must not be used for cached artifact'); } });
  assert.equal(cached.command, prepared.command);
  return { version: stdout.trim(), digest: release.digest, offline_cache: true };
});
await step('npm-and-acp-session', async () => {
  const release = await resolveAcpRelease({ id: 'codex-acp', version: '1.8.0' }, { type: 'npm', package: '@agentclientprotocol/codex-acp' });
  await writeFile('/workspace/certification-codex/release.json', JSON.stringify(release));
  const prepared = await prepareAcpRelease(release, { root });
  const runtime = new AcpRuntimeImpl(new NodeSpawner());
  const options = { agent: { command: prepared.command, args: prepared.args, cwd: '/workspace/certification-codex', env: { CODEX_HOME: '/tmp/openma-certification-codex-home' } }, perTurnTimeoutMs: 120_000 };
  const session = await runtime.start(options);
  const id = session.acpSessionId;
  const agentInfo = session.agentInfo;
  try {
    assert.ok(id);
    let reply = '';
    for await (const event of session.prompt('Reply with exactly OPENMA_CF_ARTIFACT_OK. Do not use tools.')) {
      const value = event as { sessionUpdate?: string; content?: { text?: string } };
      if (value.sessionUpdate === 'agent_message_chunk') reply += value.content?.text ?? '';
    }
    assert.match(reply, /OPENMA_CF_ARTIFACT_OK/);
  } finally { await session.dispose(); }
  const saved = JSON.parse(await readFile('/workspace/certification-codex/release.json', 'utf8'));
  const cached = await prepareAcpRelease(saved, { root, fetch: async () => { throw new Error('unexpected artifact network request'); } });
  assert.equal(cached.command, prepared.command);
  const resumed = await runtime.start({ ...options, resumeAcpSessionId: id });
  try {
    assert.equal(resumed.acpSessionId, id);
    let reply = '';
    for await (const event of resumed.prompt('Reply with exactly OPENMA_CF_RESUME_OK. Do not use tools.')) {
      const value = event as { sessionUpdate?: string; content?: { text?: string } };
      if (value.sessionUpdate === 'agent_message_chunk') reply += value.content?.text ?? '';
    }
    assert.match(reply, /OPENMA_CF_RESUME_OK/);
  } finally { await resumed.dispose(); }
  return { digest: release.digest, version: release.version, agentInfo, session_id: id, model_prompt: true, resumed_prompt: true, offline_cache: true };
});
console.log(JSON.stringify({ ok: true, steps }));
