/** Live no-inference probe. Bundle this with esbuild --bundle --platform=node --format=esm.
 * Usage: node probe.mjs <private-config.json> <receipt.json>
 * Config: { apiUrl, apiKeyFile, runtimeTokenFile, runtimeId, tenantId }.
 * The Runtime and workspace must already be paired. Creates one skill, two agents,
 * one attached Environment and four idle Sessions; retains them for inspection.
 */
import assert from "node:assert/strict";
import { readFile, writeFile, readlink, stat, readdir, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { materializeManagedSkills, configureManagedSkills, managedSkillInstructions } from "../packages/cli/src/bridge/lib/managed-skills.js";
import { ensureSessionCwd, writeBundle } from "../packages/cli/src/bridge/lib/session-cwd.js";

const [configFile, receiptFile] = process.argv.slice(2);
if (!configFile || !receiptFile) throw new Error("Usage: probe.mjs private-config.json receipt.json");
const config = JSON.parse(await readFile(configFile, "utf8")) as {
  apiUrl: string; apiKeyFile: string; runtimeTokenFile: string; runtimeId: string; tenantId: string;
};
const apiKey = (await readFile(config.apiKeyFile, "utf8")).trim();
const runtimeToken = (await readFile(config.runtimeTokenFile, "utf8")).trim();
const startedAt = new Date().toISOString();
const http: Array<{ method: string; path: string; status: number }> = [];
const downloadCounts: Record<string, number> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  const response = await realFetch(input, init);
  http.push({ method: init?.method ?? "GET", path: url.pathname + url.search, status: response.status });
  if (url.pathname.endsWith("/content")) downloadCounts[url.pathname] = (downloadCounts[url.pathname] ?? 0) + 1;
  return response;
};
async function api(path: string, body?: unknown, method = "POST") {
  const form = body instanceof FormData;
  const response = await fetch(config.apiUrl + path, {
    method: body === undefined ? "GET" : method,
    headers: { "x-api-key": apiKey, "anthropic-beta": "managed-agents-2026-04-01,skills-2025-10-02",
      ...(!form && body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${(await response.text()).slice(0, 400)}`);
  return await response.json() as any;
}
function skillForm(version: string) {
  const form = new FormData();
  form.set("display_name", "PR 498 unified cache proof");
  form.append("files[]", new File([`---\nname: runtime-cache-proof\ndescription: PR 498 immutable skill cache proof\n---\n# Runtime cache proof\nMarker: ${version}\n`], "SKILL.md", { type: "text/markdown" }));
  form.append("files[]", new File([new Uint8Array([0, 1, 255])], "asset.bin", { type: "application/octet-stream" }));
  return form;
}
const skill = await api("/v1/skills", skillForm("one"));
const environment = await api("/v1/environments", { name: "PR 498 skill cache proof", config: { type: "self_hosted" },
  _oma: { runtime: { runtime_id: config.runtimeId } } });
const agentInput = { name: "PR 498 skill cache proof", model: "gpt-6-astra", system: "Read the pinned managed skill; this receipt probe runs no inference.",
  skills: [{ skill_id: skill.id, type: "custom" }],
  _oma: { harness: "acp-proxy", runtime_binding: { runtime_id: config.runtimeId, acp_agent_id: "codex-acp" } } };
const agent = await api("/v1/agents", agentInput);
const createSession = (agentId = agent.id) => api("/v1/sessions", { agent: agentId, environment_id: environment.id });
async function apply(session: { id: string }) {
  const response = await fetch(`${config.apiUrl}/agents/runtime/sessions/${session.id}/bundle?agent_id=codex-acp&skill_cache=1`, {
    headers: { authorization: `Bearer ${runtimeToken}` },
  });
  assert.equal(response.status, 200);
  const bundle = await response.json() as any;
  assert.ok(Array.isArray(bundle.managed_skills), "Lane must support the skill_cache bundle protocol");
  const sessionDir = await ensureSessionCwd(session.id);
  const skills = await materializeManagedSkills({ sessionDir, skills: bundle.managed_skills, apiUrl: config.apiUrl,
    tenantId: config.tenantId, agentApiKey: apiKey });
  await writeBundle(sessionDir, bundle.files.map((f: { path: string; content: string }) => f.path === "AGENTS.md"
    ? { ...f, content: f.content + managedSkillInstructions(skills) } : f));
  const env = await configureManagedSkills(sessionDir, "codex-acp", skills);
  const [materialized] = skills;
  // Prove native discovery too, without launching an ACP child or mirroring user config.
  const claudeConfig = join(sessionDir, ".claude-config");
  await configureManagedSkills(sessionDir, "claude-acp", skills, claudeConfig);
  const manifest = join(materialized.linkPath, materialized.manifests[0]);
  const info = await stat(materialized.linkPath);
  const content = await readFile(manifest);
  return { sessionId: session.id, sessionDir, binding: bundle.managed_skills, env,
    ...materialized, target: await readlink(materialized.linkPath),
    targetStat: { dev: info.dev, ino: info.ino, mode: (info.mode & 0o777).toString(8) },
    manifestSha256: createHash("sha256").update(content).digest("hex"),
    manifestContent: content.toString("utf8"),
    claudeTarget: await readlink(join(claudeConfig, "skills", skill.id)),
    claudeManifest: await readFile(join(claudeConfig, "skills", skill.id, "SKILL.md"), "utf8"),
    snapshot: JSON.parse(await readFile(join(sessionDir, ".oma-skills.json"), "utf8")),
    listing: await readdir(materialized.cachePath, { recursive: true }),
  };
}
const sessionA = await createSession();
const sessionB = await createSession();
const a = await apply(sessionA);
const b = await apply(sessionB);
assert.equal(a.target, b.target);
assert.deepEqual(a.targetStat, b.targetStat);
assert.equal(Object.values(downloadCounts).reduce((n, v) => n + v, 0), 1);
const version2 = await api(`/v1/skills/${skill.id}/versions`, skillForm("two"));
const latest = await api(`/v1/skills/${skill.id}`);
assert.equal(latest.latest_version_id, version2.id);
// A repeated application uses the disk snapshot, even if latest has moved.
const resumedA = await apply(sessionA);
assert.equal(resumedA.target, a.target);
assert.equal(resumedA.manifestSha256, a.manifestSha256);
const sessionC = await createSession();
const c = await apply(sessionC);
assert.equal(c.version, version2.id);
assert.notEqual(c.target, a.target);
const pinnedAgent = await api("/v1/agents", { ...agentInput, name: "PR 498 pinned skill proof",
  skills: [{ ...agentInput.skills[0], version: a.version }] });
const pinnedSession = await createSession(pinnedAgent.id);
const pinned = await apply(pinnedSession);
assert.equal(pinned.target, a.target);
assert.equal(Object.values(downloadCounts).reduce((n, v) => n + v, 0), 2);
const receipt = { startedAt, completedAt: new Date().toISOString(), host: { hostname: hostname(), platform: process.platform, arch: process.arch },
  method: "Real lane API + daemon bundle materialization functions; no ACP child/model turn; no Environment Work queue consumption claimed",
  apiUrl: config.apiUrl, runtimeId: config.runtimeId, environmentId: environment.id, agentId: agent.id, skillId: skill.id,
  firstVersion: a.version, latestVersion: latest.latest_version_id, sessions: { a, b, resumedA, c, pinned }, downloadCounts, http,
  assertions: { sharedTargetAndInode: true, oneDownloadPerVersion: true, noHotSwapOnReapply: true, newSessionGetsLatest: true, explicitVersionStaysPinned: true,
    binaryPackageAssetsPresent: a.listing.some((p) => p.endsWith("asset.bin")), claudeDiscoversRootManifest: a.claudeManifest === a.manifestContent },
};
await mkdir(dirname(receiptFile), { recursive: true });
await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ receiptFile, host: receipt.host, assertions: receipt.assertions }, null, 2));
