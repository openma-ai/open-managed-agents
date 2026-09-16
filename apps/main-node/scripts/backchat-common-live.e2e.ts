/** Explicitly configured live OMA -> common -> ACP -> Backchat acceptance. */
import { execFile } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createNodeManagedAcpWorkItemRunner } from '../../../packages/harness-runtime-acp/src/node-work-item';
import { createManagedAcpSupervisorHarness, createManagedHarnessHttpControlChannel } from '../../../packages/harness-runtime-acp/src/index';
import { createAcpRuntime } from '../../../packages/acp-runtime/src/placement';
import { NodeSpawner } from '../../../packages/acp-runtime/src/spawners/node';
import { resolveLiveConfig, redactSecrets } from '../../../scripts/backchat-live-config.mjs';

const configFile = process.argv[2];
if (!configFile) throw new Error('Usage: pnpm exec tsx apps/main-node/scripts/backchat-common-live.e2e.ts <config.json> [--check]');
const config = resolveLiveConfig(JSON.parse(await readFile(resolve(configFile), 'utf8')));
const selected = { baseUrl: config.baseUrl, tenantId: config.tenantId, model: config.model,
  harness: config.harnessId, command: config.agent('<workspace>').command,
  args: config.agent('<workspace>').args, backchatDir: config.backchatDir };
const redact = (value: unknown) => redactSecrets(String(value), config.secrets);
if (process.argv.includes('--check')) {
  console.log(redact(JSON.stringify({ configurationValid: true, ...selected }, null, 2)));
} else {
  await run();
}
async function run() {
  // Fail before creating remote objects if the desktop checkout is not ready.
  await access(join(config.backchatDir, 'out/main/index.js'));
  await access(join(config.backchatDir, 'e2e/openma-common-live.spec.ts'));
  await mkdir(config.outputDir, { recursive: true });
  const output = await mkdtemp(join(config.outputDir, 'run-'));
  const workspace = await mkdtemp(join(tmpdir(), 'oma-backchat-live-'));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const report: Record<string, unknown> = { ok: false, ...selected, stage: 'create', workspace };
  let keyId: string | undefined;
  let worker: Promise<void> | undefined;
  let workerError: unknown;
  let workerExited = false;
  const request = async (path: string, body?: unknown, headers: Record<string, string> = {}, method?: string) => {
    const response = await fetch(config.baseUrl + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'x-api-key': config.token, 'anthropic-beta': 'managed-agents-2026-04-01', 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`);
    return response.json() as Promise<any>;
  };
  try {
    const agent = await request('/v1/agents', { name: 'Backchat live acceptance', model: config.model, system: 'Follow the user request. Keep responses short.' });
    report.agentId = agent.id;
    const environment = await request('/v1/environments', { name: 'Backchat live acceptance', config: { type: 'self_hosted' } });
    report.environmentId = environment.id;
    const session = await request('/v1/sessions', { agent: agent.id, environment_id: environment.id, title: 'Backchat live acceptance' });
    report.sessionId = session.id;
    const key = await request('/v1/oma/api_keys', { name: 'Backchat live worker', environment_id: environment.id });
    keyId = key.id;
    config.secrets.push(key.key);
    await request(`/v1/sessions/${session.id}/events`, { events: [{ type: 'user.message', content: [{ type: 'text', text: 'Reply exactly COMMON_KERNEL_FIRST_OK. Do not use tools.' }] }] }, { 'Idempotency-Key': 'backchat-live-first' });
    report.stage = 'work-poll';
    const response = await fetch(`${config.baseUrl}/v1/environments/${environment.id}/work/poll?block_ms=100`, {
      headers: { Authorization: `Bearer ${key.key}`, 'anthropic-beta': 'managed-agents-2026-04-01', 'Anthropic-Worker-ID': 'backchat-live-acceptance' }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Work poll: HTTP ${response.status}`);
    const payload = await response.json() as any;
    const work = payload.data?.[0] ?? payload.work ?? payload;
    if (!work.secret || work.data?.id !== session.id) throw new Error('Work poll did not return the created session');
    config.secrets.push(work.secret);
    const capability = JSON.parse(Buffer.from(work.secret, 'base64url').toString());
    config.secrets.push(capability.sessions_token);
    const harness = createManagedAcpSupervisorHarness({
      connect: async input => createManagedHarnessHttpControlChannel({ ...input, apiBaseUrl: config.baseUrl, sessionsToken: capability.sessions_token }),
      acpRuntime: createAcpRuntime({ type: 'local', spawner: new NodeSpawner() }),
      sessionPreparation: { prepare: async () => ({ agent: config.agent(workspace) }) },
      sessionState: { beforeStart: async command => ({ command }), onReady: async () => {}, checkpoint: async () => {}, release: async () => {} },
    });
    const runner = createNodeManagedAcpWorkItemRunner({
      environment: { ANTHROPIC_BASE_URL: config.baseUrl, ANTHROPIC_ENVIRONMENT_ID: environment.id, ANTHROPIC_SESSION_ID: session.id,
        ANTHROPIC_WORK_ID: work.id, ANTHROPIC_WORK_SECRET: work.secret, OPENMA_WORKSPACE_ID: config.tenantId, OPENMA_HARNESS_ID: config.harnessId },
      supervisorApp: { resolveHarness: async () => harness, serve: async () => {} }, workspacePath: workspace, outputPath: null,
      onError: error => { workerError = error; },
    });
    worker = runner.run(controller.signal).catch(error => { workerError = error; }).finally(() => { workerExited = true; });
    report.stage = 'oma-first-turn';
    const deadline = Date.now() + config.timeoutMs;
    while (true) {
      controller.signal.throwIfAborted();
      if (workerError) throw workerError;
      if (workerExited) throw new Error('Worker exited before the first model response');
      const events = (await request(`/v1/sessions/${session.id}/events?order=asc&limit=100`)).data;
      const error = events.find((event: any) => event.type === 'session.error');
      if (error) throw new Error(error.error?.message ?? 'Session failed');
      if (events.some((event: any) => event.type === 'agent.message' && event.content?.some((part: any) => part.text?.includes('COMMON_KERNEL_FIRST_OK')))) break;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the first model response');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    report.stage = 'backchat-continuation-and-restart';
    const { stdout, stderr } = await promisify(execFile)('pnpm', ['exec', 'playwright', 'test', 'e2e/openma-common-live.spec.ts', '--reporter=list', `--output=${join(output, 'desktop')}`], {
      cwd: config.backchatDir, timeout: config.timeoutMs + 30_000, maxBuffer: 4 * 1024 * 1024, signal: controller.signal,
      env: { ...process.env, OPENMA_LIVE_BASE_URL: config.baseUrl, OPENMA_LIVE_SESSION_ID: session.id, OPENMA_LIVE_TEST_TOKEN: config.token,
        OPENMA_LIVE_TENANT_ID: config.tenantId, OPENMA_LIVE_TENANT_NAME: config.tenantName, OPENMA_LIVE_USER_ID: config.user.id,
        OPENMA_LIVE_USER_EMAIL: config.user.email, OPENMA_LIVE_TIMEOUT_MS: String(config.timeoutMs) },
    });
    await writeFile(join(output, 'desktop.log'), redact(stdout + stderr), { mode: 0o600 });
    if (workerError) throw workerError;
    if (workerExited) throw new Error('Worker exited during desktop acceptance');
    report.ok = true;
    report.stage = 'complete';
  } catch (error) {
    const failure = error as { message?: string; stdout?: string; stderr?: string };
    report.error = redact(failure.message ?? error);
    await writeFile(join(output, 'failure.log'), redact(`${failure.message ?? error}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`), { mode: 0o600 });
    process.exitCode = 1;
  } finally {
    controller.abort();
    if (worker) await worker;
    if (keyId) {
      try { await request(`/v1/oma/api_keys/${keyId}`, undefined, {}, 'DELETE'); }
      catch (error) { report.cleanupError = redact(error); report.ok = false; process.exitCode = 1; }
    }
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await writeFile(join(output, 'report.json'), redact(JSON.stringify(report, null, 2)), { mode: 0o600 });
    console.log(redact(JSON.stringify({ ...report, output }, null, 2)));
  }
}
