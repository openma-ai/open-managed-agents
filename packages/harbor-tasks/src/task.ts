import { parse } from "smol-toml";
import type { HarborTaskFile } from "./bundle";

/**
 * A Harbor task directory (task.toml, instruction.md, tests/, solution/)
 * resolved into the subset OMA can run today. Anything outside that subset
 * fails with UnsupportedHarborTaskError instead of being silently ignored,
 * so a reported score never comes from a weaker environment than the task
 * declared.
 */
export interface HarborTask {
  name: string;
  instruction: string;
  /** Prebuilt image from [environment].docker_image. */
  image: string;
  /** [agent].timeout_sec; null means Harbor applies no task-level limit. */
  agentTimeoutSec: number | null;
  /** [verifier].timeout_sec, Harbor default 600. */
  verifierTimeoutSec: number;
  cpus: number | null;
  memoryMb: number | null;
  verifierEnv: Record<string, string>;
  solutionEnv: Record<string, string>;
  /** tests/ (relative to tests/); always contains test.sh. */
  tests: HarborTaskFile[];
  /** solution/ (relative to solution/); null when there is no solve.sh. */
  solution: HarborTaskFile[] | null;
}

export class UnsupportedHarborTaskError extends Error {
  constructor(task: string, reason: string) {
    super(`Harbor task ${task} is not supported: ${reason}`);
    this.name = "UnsupportedHarborTaskError";
  }
}

type Table = Record<string, unknown>;

function table(value: unknown): Table {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Table : {};
}

function stringMap(value: unknown, field: string, task: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(table(value))) {
    if (typeof entry !== "string") throw new UnsupportedHarborTaskError(task, `${field}.${key} must be a string`);
    result[key] = entry;
  }
  return result;
}

function optionalNumber(value: unknown, field: string, task: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new UnsupportedHarborTaskError(task, `${field} must be a positive number`);
  }
  return value;
}

/** Harbor's EnvironmentConfig._parse_size_to_mb: G/M/K suffixes, G = 1024 MB. */
export function parseHarborSizeToMb(size: string): number {
  const value = size.trim().toUpperCase();
  const amount = Number.parseFloat(value.slice(0, -1));
  if (!Number.isFinite(amount)) throw new Error(`Invalid size format: ${size}`);
  if (value.endsWith("G")) return Math.trunc(amount * 1024);
  if (value.endsWith("M")) return Math.trunc(amount);
  if (value.endsWith("K")) return Math.trunc(amount / 1024);
  throw new Error(`Invalid size format: ${size}. Expected format like '1G', '512M'`);
}

function requirePublicNetwork(section: Table, field: string, task: string) {
  const mode = section.network_mode;
  if (mode !== undefined && mode !== "public") {
    throw new UnsupportedHarborTaskError(task, `${field}.network_mode=${String(mode)} cannot be enforced yet (#295)`);
  }
  if (section.allow_internet === false) {
    throw new UnsupportedHarborTaskError(task, `${field}.allow_internet=false cannot be enforced yet (#295)`);
  }
}

function under(files: readonly HarborTaskFile[], dir: string): HarborTaskFile[] {
  return files
    .filter((file) => file.path.startsWith(`${dir}/`))
    .map((file) => ({ ...file, path: file.path.slice(dir.length + 1) }));
}

function utf8(file: HarborTaskFile | undefined): string | null {
  return file === undefined ? null : new TextDecoder().decode(file.bytes);
}

/**
 * Resolve a Harbor task directory, given as its files relative to the task
 * root, into the subset OMA runs. Pure: works on Node and Workers.
 */
export function parseHarborTask(name: string, files: readonly HarborTaskFile[]): HarborTask {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const toml = utf8(byPath.get("task.toml"));
  if (toml === null) throw new UnsupportedHarborTaskError(name, "missing task.toml");
  let config: Table;
  try { config = parse(toml) as Table; }
  catch (error) { throw new UnsupportedHarborTaskError(name, `invalid task.toml: ${error instanceof Error ? error.message : String(error)}`); }
  const environment = table(config.environment);
  const agent = table(config.agent);
  const verifier = table(config.verifier);

  if (Array.isArray(config.steps) && config.steps.length > 0) {
    throw new UnsupportedHarborTaskError(name, "multi-step tasks");
  }
  if (environment.os !== undefined && environment.os !== "linux") {
    throw new UnsupportedHarborTaskError(name, `environment.os=${String(environment.os)}`);
  }
  if (byPath.has("environment/docker-compose.yaml") || byPath.has("environment/docker-compose.yml")) {
    throw new UnsupportedHarborTaskError(name, "multi-container (docker-compose) environments");
  }
  requirePublicNetwork(environment, "environment", name);
  requirePublicNetwork(agent, "agent", name);
  requirePublicNetwork(table(verifier), "verifier", name);
  requirePublicNetwork(table(verifier.environment), "verifier.environment", name);
  if (typeof environment.docker_image !== "string" || environment.docker_image.trim() === "") {
    throw new UnsupportedHarborTaskError(name, "no prebuilt environment.docker_image (building environment/Dockerfile is not supported yet)");
  }
  if (environment.gpus !== undefined && environment.gpus !== 0) {
    throw new UnsupportedHarborTaskError(name, "GPU environments");
  }

  let memoryMb = optionalNumber(environment.memory_mb, "environment.memory_mb", name);
  if (typeof environment.memory === "string") {
    const parsed = parseHarborSizeToMb(environment.memory);
    if (memoryMb !== null && memoryMb !== parsed) {
      throw new UnsupportedHarborTaskError(name, "conflicting environment.memory and environment.memory_mb");
    }
    memoryMb = parsed;
  }

  const tests = under(files, "tests");
  if (!tests.some((file) => file.path === "test.sh")) throw new UnsupportedHarborTaskError(name, "missing tests/test.sh");
  const solution = under(files, "solution");
  const instruction = utf8(byPath.get("instruction.md"));
  if (instruction === null) throw new UnsupportedHarborTaskError(name, "missing instruction.md");

  return {
    name,
    instruction,
    image: environment.docker_image.trim(),
    agentTimeoutSec: optionalNumber(agent.timeout_sec, "agent.timeout_sec", name),
    verifierTimeoutSec: optionalNumber(verifier.timeout_sec, "verifier.timeout_sec", name) ?? 600,
    cpus: optionalNumber(environment.cpus, "environment.cpus", name),
    memoryMb,
    verifierEnv: stringMap(verifier.env, "verifier.env", name),
    solutionEnv: stringMap(table(config.solution).env, "solution.env", name),
    tests,
    solution: solution.some((file) => file.path === "solve.sh") ? solution : null,
  };
}
