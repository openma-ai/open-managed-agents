// Deterministic model fixture for resource-convergence behavior tests.
//
// EVIDENCE LEVEL: deterministic model transport fixture. No paid inference.
// The fixture plays the model: it sees ONLY what the production harness
// actually sent (system prompt, tool list, prior tool results) and decides the
// next tool call from that. It never receives paths from the test. If the
// platform did not tell the model where a resource lives, the fixture cannot
// find it and answers `DISCOVERY_FAILED:<what>` — exactly the failure a real
// model would have. Tool execution, storage and collection are all real.
//
// Discovery is wording-agnostic on purpose: it looks for absolute paths in the
// prompt, not for any particular sentence, so it does not pin one guidance
// text (core-host owns that text).

export const SKILL_NAME = "report-kit";
export const SKILL_SEED = "alpha\nβeta\tγ\n";
/** What `sh scripts/make-report.sh <out>` writes when run from the Skill dir. */
export const EXPECTED_REPORT = `REPORT v1\n${SKILL_SEED}lines=2\n`;
export const REPORT_FILENAME = "skill-report.txt";
export const WRONG_CONTEXT_FILENAME = "wrong-context.txt";

export const SKILL_MD = [
  "---",
  `name: ${SKILL_NAME}`,
  "description: Builds a small report from the bundled seed data.",
  "---",
  "",
  "# Report kit",
  "",
  "Run `sh scripts/make-report.sh <output-file>` from this skill's directory.",
  "The script reads `data/seed.txt` relative to the skill directory.",
  "",
].join("\n");

/** Fails (exit 3) unless the working directory is the Skill directory. */
export const MAKE_REPORT_SH = [
  "#!/bin/sh",
  "set -eu",
  "out=\"$1\"",
  "if [ ! -f ./data/seed.txt ]; then echo \"make-report: not run from the skill directory ($(pwd))\" >&2; exit 3; fi",
  "mkdir -p \"$(dirname \"$out\")\"",
  "{ printf 'REPORT v1\\n'; cat ./data/seed.txt; printf 'lines=%s\\n' \"$(wc -l < ./data/seed.txt | tr -d ' ')\"; } > \"$out\"",
  "printf 'make-report wrote %s\\n' \"$out\"",
  "",
].join("\n");

export const SKILL_FILES: ReadonlyArray<{ name: string; content: string }> = [
  { name: `${SKILL_NAME}/SKILL.md`, content: SKILL_MD },
  { name: `${SKILL_NAME}/scripts/make-report.sh`, content: MAKE_REPORT_SH },
  { name: `${SKILL_NAME}/data/seed.txt`, content: SKILL_SEED },
];

/** Bytes the agent writes to read-write Memory: non-ASCII, tab, no final newline. */
export const MEMORY_FACT = "fact: β-42\tline one\nline two ✓ no-final-newline";
export const MEMORY_FACT_FILE = "fact.md";
export const READONLY_SEED = "read-only seed § do not change\n";
export const READONLY_SEED_FILE = "seed.md";
export const READONLY_MUTATION = "MUTATED-BY-AGENT";

const PATH_TOKEN = /\/[A-Za-z0-9._~%@+\-/]+/gu;

export function flattenSystem(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n");
  return "";
}

function pathTokens(text: string): string[] {
  return [...text.matchAll(PATH_TOKEN)].map((match) => match[0].replace(/[.,;:]+$/u, ""));
}

/** Absolute directory the prompt advertises for a Memory Store. */
export function discoverMemoryPath(system: string, names: readonly string[]): string | null {
  for (const token of pathTokens(system)) {
    const trimmed = token.replace(/\/+$/u, "");
    const last = trimmed.split("/").at(-1);
    if (last !== undefined && names.includes(last) && /memory/iu.test(trimmed)) return trimmed;
  }
  return null;
}

/** Absolute SKILL.md the prompt advertises; a directory named after the Skill
 * with an instruction to read its SKILL.md counts too (a real model would). */
export function discoverSkillManifest(system: string, skillId: string): string | null {
  const tokens = pathTokens(system);
  const explicit = tokens.find((token) => token.endsWith("/SKILL.md") && (token.includes(skillId) || token.includes(SKILL_NAME)));
  if (explicit) return explicit;
  if (!/SKILL\.md/u.test(system)) return null;
  const directory = tokens.find((token) => token.includes(skillId) || token.split("/").includes(SKILL_NAME));
  return directory ? `${directory.replace(/\/+$/u, "")}/SKILL.md` : null;
}

export function discoverOutputsDir(system: string): string | null {
  const token = pathTokens(system).map((t) => t.replace(/\/+$/u, "")).find((t) => /\/outputs$/u.test(t));
  return token ?? null;
}

export const B64_OPEN = "B64[";
export const B64_CLOSE = "]B64";
export function catBase64Command(path: string): string {
  return `printf '${B64_OPEN}'; base64 ${shq(path)} | tr -d '\\n'; printf '${B64_CLOSE}'`;
}
export function decodeMarkedBase64(text: string): string | null {
  const open = text.indexOf(B64_OPEN);
  const close = text.indexOf(B64_CLOSE, open + B64_OPEN.length);
  if (open < 0 || close < 0) return null;
  return Buffer.from(text.slice(open + B64_OPEN.length, close), "base64").toString("utf8");
}
export function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type FixtureReply = { text: string } | { name: string; input: Record<string, unknown> };

export interface TurnPlanContext {
  system: string;
  toolNames: readonly string[];
  /** Tool results of the current turn, oldest first. */
  results: ReadonlyArray<{ text: string; isError: boolean }>;
}

export interface ResourceAgentScenario {
  skillId: string;
  rwNames: readonly string[];
  roNames: readonly string[];
  /** DIAGNOSTIC ONLY (never acceptance): Memory paths supplied by the test
   * when the prompt does not advertise them, to characterize the IO path
   * independently of guidance. Every use is recorded in `hintUses`. */
  memoryHints?: { rw: string; ro: string };
  hintUses?: string[];
}

function memoryPath(scenario: ResourceAgentScenario, system: string, which: "rw" | "ro"): string | null {
  const found = discoverMemoryPath(system, which === "rw" ? scenario.rwNames : scenario.roNames);
  if (found !== null || scenario.memoryHints === undefined) return found;
  scenario.hintUses?.push(which);
  return scenario.memoryHints[which];
}

/** Turn A: discover + read Skill, wrong-context negative control, relative
 * script from the Skill dir into the outputs dir, write Memory, attempt a
 * read-only mutation, observe its error and end the turn. */
export function turnA(scenario: ResourceAgentScenario, ctx: TurnPlanContext): FixtureReply {
  const step = ctx.results.length;
  const manifest = discoverSkillManifest(ctx.system, scenario.skillId);
  const outputs = discoverOutputsDir(ctx.system);
  const rw = step === 3 ? memoryPath(scenario, ctx.system, "rw") : null;
  const ro = step === 4 ? memoryPath(scenario, ctx.system, "ro") : null;
  if (step === 0) {
    if (manifest === null) return { text: "DISCOVERY_FAILED:skill_manifest" };
    return { name: "read", input: { file_path: manifest } };
  }
  if (step === 1) {
    const command = /`(sh scripts\/[^`<]+)<output-file>`/u.exec(ctx.results[0]!.text)?.[1]?.trim();
    if (command === undefined) return { text: "DISCOVERY_FAILED:skill_command_not_in_manifest_read_result" };
    if (outputs === null) return { text: "DISCOVERY_FAILED:outputs_dir" };
    // Negative control: same relative command from the default cwd.
    return { name: "bash", input: { command: `${command} ${outputs}/${WRONG_CONTEXT_FILENAME}` } };
  }
  if (step === 2) {
    const command = /`(sh scripts\/[^`<]+)<output-file>`/u.exec(ctx.results[0]!.text)![1]!.trim();
    const directory = manifest!.slice(0, -"/SKILL.md".length);
    return { name: "bash", input: { command: `cd ${shq(directory)} && ${command} ${outputs}/${REPORT_FILENAME}` } };
  }
  if (step === 3) {
    if (rw === null) return { text: "DISCOVERY_FAILED:memory_read_write_path" };
    return { name: "write", input: { file_path: `${rw}/${MEMORY_FACT_FILE}`, content: MEMORY_FACT } };
  }
  if (step === 4) {
    if (ro === null) return { text: "DISCOVERY_FAILED:memory_read_only_path" };
    return { name: "write", input: { file_path: `${ro}/${READONLY_SEED_FILE}`, content: READONLY_MUTATION } };
  }
  const last = ctx.results.at(-1)!;
  return { text: last.isError ? "TURN_A_DONE readonly-refused-observed" : "TURN_A_DONE readonly-write-NOT-refused" };
}

/** Recall turn: read the persisted fact bytes (and optionally a second file)
 * through the sandbox, then end the turn. */
export function recallTurn(scenario: ResourceAgentScenario, ctx: TurnPlanContext, files: readonly string[]): FixtureReply {
  const step = ctx.results.length;
  const rw = step < files.length ? memoryPath(scenario, ctx.system, "rw") : "";
  if (rw === null) return { text: "DISCOVERY_FAILED:memory_read_write_path" };
  if (step < files.length) return { name: "bash", input: { command: catBase64Command(`${rw}/${files[step]}`) } };
  return { text: `RECALL_DONE ${files.length}` };
}
