import { resolve } from 'node:path';

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}
export function redactSecrets(value, secrets) {
  return [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join('<redacted>'), String(value));
}
export function resolveLiveConfig(raw, environment = process.env) {
  const base = new URL(required(raw.baseUrl, 'baseUrl'));
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('baseUrl must be an HTTP(S) endpoint without credentials, query or fragment');
  }
  const model = required(raw.model, 'model');
  const id = required(raw.acp?.id, 'acp.id');
  const command = required(raw.acp?.command, 'acp.command');
  const args = raw.acp.args ?? [];
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('acp.args must be a string array');
  const bindings = raw.acp.env ?? {};
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('acp.env must be an object');
  const token = required(environment[required(raw.tokenEnv, 'tokenEnv')], raw.tokenEnv);
  const secrets = [token];
  const resolvedEnvironment = {};
  for (const [name, value] of Object.entries(bindings)) {
    if (typeof value === 'string') resolvedEnvironment[name] = value;
    else {
      const source = required(value?.fromEnv, `acp.env.${name}.fromEnv`);
      const secret = required(environment[source], source);
      resolvedEnvironment[name] = secret;
      secrets.push(secret);
    }
  }
  if (![...args, ...Object.values(bindings).filter(value => typeof value === 'string')].some(value => value.includes('{model}'))) {
    throw new Error('Wire {model} into acp.args or acp.env so the actual ACP uses the configured model');
  }
  const timeoutMs = raw.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new Error('timeoutMs must be between 1000 and 600000');
  const tenantId = required(raw.tenantId, 'tenantId');
  const user = { id: required(raw.user?.id, 'user.id'), email: required(raw.user?.email, 'user.email') };
  return {
    baseUrl: base.toString().replace(/\/$/, ''), token, secrets, model, tenantId, user,
    tenantName: required(raw.tenantName, 'tenantName'),
    backchatDir: resolve(required(raw.backchatDir, 'backchatDir')),
    outputDir: resolve(raw.outputDir ?? 'artifacts/backchat-live'), timeoutMs, harnessId: id,
    agent(workspace) {
      const expand = value => value.replaceAll('{model}', model).replaceAll('{workspace}', workspace);
      return { command, args: args.map(expand), cwd: workspace,
        env: Object.fromEntries(Object.entries(resolvedEnvironment).map(([name, value]) =>
          [name, typeof bindings[name] === 'string' ? expand(value) : value])),
      };
    },
  };
}
