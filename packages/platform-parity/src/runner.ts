import type { ParityObservation } from "./normalize";
import { serializeObservation } from "./normalize";
import type { ParityScenario } from "./context";

/**
 * A known difference: this runner's result for `scenario` differs from the
 * golden at exactly `paths` (JSON pointers into ParityObservation). Declared
 * inline in the runner and registered as Vitest `test.fails`, so:
 *   - a new difference fails the strict golden test / the masked test,
 *   - a fixed difference makes `test.fails` pass unexpectedly → red,
 *     forcing the declaration to be deleted (pytest xfail(strict=True)).
 */
export interface KnownDifference {
  scenario: string;
  /** Short label, used in the test name. */
  title: string;
  /** JSON pointers into the observation this difference changes (never /event_types). */
  paths: string[];
  /**
   * Event types whose presence or position this difference changes. They are
   * removed from /event_types on both sides when the rest is compared.
   */
  eventTypes?: string[];
  /** Golden (reference) value, this platform's value, and the file:line cause. */
  cause: string;
}

export interface ParityTestApi {
  describe: (name: string, fn: () => void) => void;
  test: {
    (name: string, fn: () => Promise<void>, timeout?: number): void;
    fails: (name: string, fn: () => Promise<void>, timeout?: number) => void;
  };
  expect: any;
}

export interface ParityRunnerOptions {
  runner: string;
  scenarios: ParityScenario[];
  /** Run one scenario through the platform's public API. */
  run: (scenario: ParityScenario) => Promise<ParityObservation>;
  /** golden/<name>.json, relative to the runner test file. */
  goldenFile: (scenario: string) => string;
  /** Raw golden texts (import.meta.glob ?raw), keyed by scenario name. */
  goldens: Record<string, string | undefined>;
  knownDifferences: KnownDifference[];
  timeoutMs?: number;
}

type Json = unknown;

function decode(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function encode(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export const ABSENT = "<absent>";

/** JSON-pointer paths where `a` and `b` differ. Arrays of different length differ as a whole. */
export function differingPaths(a: Json, b: Json, path = ""): string[] {
  if (Object.is(a, b)) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [path || "/"];
    return a.flatMap((item, index) => differingPaths(item, b[index], `${path}/${index}`));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
    return keys.flatMap((key) => {
      const left = key in (a as object) ? (a as Record<string, Json>)[key] : ABSENT;
      const right = key in (b as object) ? (b as Record<string, Json>)[key] : ABSENT;
      return differingPaths(left, right, `${path}/${encode(key)}`);
    });
  }
  return [path || "/"];
}

function getAt(value: Json, path: string): Json {
  if (path === "/" || path === "") return value;
  let current: Json = value;
  for (const segment of path.split("/").slice(1).map(decode)) {
    if (current === null || typeof current !== "object") return ABSENT;
    const record = current as Record<string, Json>;
    if (!(segment in record)) return ABSENT;
    current = record[segment];
  }
  return current;
}

function setAt(value: Json, path: string, replacement: Json): Json {
  if (path === "/" || path === "") return replacement;
  const copy = structuredClone(value) as Record<string, Json>;
  const segments = path.split("/").slice(1).map(decode);
  let current: Record<string, Json> = copy;
  for (const segment of segments.slice(0, -1)) {
    if (current[segment] === null || typeof current[segment] !== "object") current[segment] = {};
    current = current[segment] as Record<string, Json>;
  }
  const last = segments.at(-1)!;
  if (replacement === ABSENT) delete current[last];
  else current[last] = replacement;
  return copy;
}

/** `actual` with every declared path replaced by the golden's value. */
export function maskKnownPaths(actual: Json, golden: Json, paths: string[]): Json {
  let masked = actual;
  for (const path of paths) masked = setAt(masked, path, getAt(golden, path));
  return masked;
}

/**
 * (actual, golden) with the given differences taken out: their paths carry
 * the golden value, their event types are dropped from /event_types on both
 * sides. Whatever still differs is not explained by those differences.
 */
export function maskDifferences(
  actual: ParityObservation,
  golden: ParityObservation,
  differences: KnownDifference[],
): { actual: ParityObservation; golden: ParityObservation } {
  const paths = differences.flatMap((difference) => difference.paths);
  const types = new Set(differences.flatMap((difference) => difference.eventTypes ?? []));
  const drop = (observation: ParityObservation): ParityObservation => ({
    ...observation,
    event_types: observation.event_types.filter((type) => !types.has(type)),
  });
  return {
    actual: drop(maskKnownPaths(actual, golden, paths) as ParityObservation),
    golden: drop(golden),
  };
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Declarations must be disjoint, or one difference could hide another. */
export function declarationErrors(runner: string, scenarios: ParityScenario[], differences: KnownDifference[]): string[] {
  const errors: string[] = [];
  const names = new Set(scenarios.map((scenario) => scenario.name));
  differences.forEach((difference, index) => {
    const label = `${runner}: known difference ${difference.scenario}/${difference.title}`;
    if (!names.has(difference.scenario)) errors.push(`${label} names unknown scenario ${difference.scenario}`);
    if (difference.paths.length === 0 && (difference.eventTypes ?? []).length === 0) errors.push(`${label} declares nothing`);
    for (const path of difference.paths) {
      if (!path.startsWith("/") || path === "/") errors.push(`${label}: path ${path} must be a JSON pointer below the root`);
      if (overlaps(path, "/event_types")) errors.push(`${label}: declare event order with eventTypes, not ${path}`);
    }
    for (const other of differences.slice(index + 1).filter((candidate) => candidate.scenario === difference.scenario)) {
      for (const path of difference.paths) {
        for (const otherPath of other.paths) {
          if (overlaps(path, otherPath)) errors.push(`${label} and ${other.title} both declare ${path} / ${otherPath}`);
        }
      }
      for (const type of difference.eventTypes ?? []) {
        if ((other.eventTypes ?? []).includes(type)) errors.push(`${label} and ${other.title} both declare event type ${type}`);
      }
    }
  });
  return errors;
}

/**
 * Register one runner's tests. Each scenario runs once; its result feeds:
 *   - no known difference: `toMatchFileSnapshot(golden)` (the single source
 *     of truth every runner compares against);
 *   - known differences: (1) a masked comparison: with every declared
 *     difference taken out, the rest must equal the golden, so a new
 *     difference fails; (2) one `test.fails` per difference comparing with
 *     only the OTHER differences taken out: it fails while the difference
 *     exists and passes (= red) as soon as the platform matches the golden.
 */
export function registerParityRunner(api: ParityTestApi, options: ParityRunnerOptions): void {
  const results = new Map<string, Promise<ParityObservation>>();
  const once = (scenario: ParityScenario) => {
    let result = results.get(scenario.name);
    if (result === undefined) {
      result = options.run(scenario);
      results.set(scenario.name, result);
    }
    return result;
  };
  const timeout = options.timeoutMs ?? 90_000;
  const errors = declarationErrors(options.runner, options.scenarios, options.knownDifferences);
  if (errors.length > 0) throw new Error(errors.join("\n"));

  api.describe(`platform parity [${options.runner}]`, () => {
    for (const scenario of options.scenarios) {
      const differences = options.knownDifferences.filter((difference) => difference.scenario === scenario.name);
      const golden = () => {
        const text = options.goldens[scenario.name];
        if (text === undefined) {
          throw new Error(`missing golden ${options.goldenFile(scenario.name)}; generate it from a runner with no known difference for ${scenario.name}`);
        }
        return JSON.parse(text) as ParityObservation;
      };

      if (differences.length === 0) {
        api.test(`${scenario.name} matches golden (${scenario.covers})`, async () => {
          const observation = await once(scenario);
          await api.expect(serializeObservation(observation)).toMatchFileSnapshot(options.goldenFile(scenario.name));
        }, timeout);
        continue;
      }

      api.test(`${scenario.name} matches golden outside its ${differences.length} known difference(s)`, async () => {
        const masked = maskDifferences(await once(scenario), golden(), differences);
        api.expect(
          differingPaths(masked.golden, masked.actual),
          `${options.runner}/${scenario.name}: differences not declared as known`,
        ).toEqual([]);
      }, timeout);

      for (const difference of differences) {
        const others = differences.filter((candidate) => candidate !== difference);
        api.test.fails(`${scenario.name} known difference: ${difference.title}`, async () => {
          const masked = maskDifferences(await once(scenario), golden(), others);
          api.expect(
            masked.actual,
            `${options.runner}/${scenario.name} still differs (${difference.cause}); when this passes, delete the declaration`,
          ).toEqual(masked.golden);
        }, timeout);
      }
    }
  });
}

/** Paths where an observation differs from its golden (used to write declarations). */
export function describeDifferences(observation: ParityObservation, golden: ParityObservation) {
  return differingPaths(golden, observation).map((path) => ({
    path,
    golden: getAt(golden, path),
    actual: getAt(observation, path),
  }));
}
