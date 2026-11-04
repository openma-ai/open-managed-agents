/**
 * Five-field cron helpers for the Deployments schedule editor.
 *
 * The server plans runs with croner (`deployment-schedule-planner.ts`), so
 * this module only has to agree with it on the standard subset the Console
 * writes: `minute hour day-of-month month day-of-week`, with `*`, `a-b`,
 * `a,b`, `* /n` steps and JAN/SUN-style names. When both day fields are
 * restricted a day matches either one (Vixie cron / croner legacy mode).
 * The preview is advisory; the server's `upcoming_runs_at` stays the
 * source of truth once a deployment exists.
 */

export type CronFrequency =
  | "every_minute"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom";

export interface SchedulePreset {
  frequency: Exclude<CronFrequency, "custom">;
  /** 0–23. Ignored by `every_minute` and `hourly`. */
  hour: number;
  /** 0–59. Ignored by `every_minute`. */
  minute: number;
  /** 0 (Sunday) – 6. Only used by `weekly`. */
  weekday: number;
}

export interface ParsedCron {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  /** Day-of-month field was not `*`. */
  domRestricted: boolean;
  /** Day-of-week field was not `*`. */
  dowRestricted: boolean;
}

export type CronParseResult =
  | { ok: true; cron: ParsedCron }
  | { ok: false; error: string };

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset added to a name's index (months are 1-based). */
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  // 7 is accepted as Sunday and folded to 0 after parsing.
  { name: "day of week", min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

function parseValue(raw: string, spec: FieldSpec): number | null {
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    return value >= spec.min && value <= spec.max ? value : null;
  }
  const index = spec.names?.indexOf(raw.toUpperCase()) ?? -1;
  return index >= 0 ? index + (spec.nameBase ?? 0) : null;
}

function parseField(raw: string, spec: FieldSpec): Set<number> | string {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [range, stepRaw, extra] = part.split("/");
    if (extra !== undefined || !range) return `Invalid ${spec.name}: "${part}"`;
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1) {
        return `Invalid ${spec.name} step: "${part}"`;
      }
      step = Number(stepRaw);
    }
    let start: number;
    let end: number;
    if (range === "*") {
      start = spec.min;
      end = spec.max;
    } else {
      const bounds = range.split("-");
      if (bounds.length > 2) return `Invalid ${spec.name}: "${part}"`;
      const low = parseValue(bounds[0]!, spec);
      const high = bounds.length === 2 ? parseValue(bounds[1]!, spec) : low;
      if (low === null || high === null) return `Invalid ${spec.name}: "${part}"`;
      if (low > high) return `Invalid ${spec.name} range: "${part}"`;
      start = low;
      // `5/15` means "from 5 every 15" through the field's end.
      end = bounds.length === 1 && stepRaw !== undefined ? spec.max : high;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

/** Parse a five-field cron expression. */
export function parseCron(expression: string): CronParseResult {
  const parts = expression.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    return { ok: false, error: "Expected 5 fields: minute hour day month weekday" };
  }
  const sets: Set<number>[] = [];
  for (let i = 0; i < FIELDS.length; i += 1) {
    const parsed = parseField(parts[i]!, FIELDS[i]!);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    sets.push(parsed);
  }
  const daysOfWeek = sets[4]!;
  if (daysOfWeek.delete(7)) daysOfWeek.add(0);
  return {
    ok: true,
    cron: {
      minutes: sets[0]!,
      hours: sets[1]!,
      daysOfMonth: sets[2]!,
      months: sets[3]!,
      daysOfWeek,
      domRestricted: parts[2] !== "*",
      dowRestricted: parts[4] !== "*",
    },
  };
}

/** Preset → cron expression. */
export function buildCronExpression(preset: SchedulePreset): string {
  const { minute, hour, weekday } = preset;
  switch (preset.frequency) {
    case "every_minute":
      return "* * * * *";
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
  }
}

const PLAIN_NUMBER = /^\d+$/;

/** Cron expression → preset, or null when it needs the custom editor.
 *  Round-trips everything `buildCronExpression` produces. */
export function presetFromCron(expression: string): SchedulePreset | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 || !parseCron(expression).ok) return null;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (dom !== "*" || month !== "*") return null;
  if (minute === "*" && hour === "*" && dow === "*") {
    return { frequency: "every_minute", hour: 0, minute: 0, weekday: 1 };
  }
  if (!PLAIN_NUMBER.test(minute)) return null;
  const m = Number(minute);
  if (hour === "*" && dow === "*") {
    return { frequency: "hourly", hour: 0, minute: m, weekday: 1 };
  }
  if (!PLAIN_NUMBER.test(hour)) return null;
  const h = Number(hour);
  if (dow === "*") return { frequency: "daily", hour: h, minute: m, weekday: 1 };
  if (dow === "1-5") return { frequency: "weekdays", hour: h, minute: m, weekday: 1 };
  if (PLAIN_NUMBER.test(dow)) {
    return { frequency: "weekly", hour: h, minute: m, weekday: Number(dow) % 7 };
  }
  return null;
}

// ─── Time zone arithmetic ────────────────────────────────────────────

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** True when the runtime recognises `timeZone` as an IANA zone. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function wallClockAt(instant: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
  };
}

function wallClockAsUtc(clock: WallClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
}

/** Minutes the zone is ahead of UTC at `instant`. */
export function timeZoneOffsetMinutes(instant: number, timeZone: string): number {
  return (wallClockAsUtc(wallClockAt(instant, timeZone)) - Math.floor(instant / 60_000) * 60_000) / 60_000;
}

/** Wall-clock time in `timeZone` → instant, or null when the time does not
 *  exist there (skipped by a DST jump). Ambiguous times take the earlier
 *  instant, as croner does. */
function zonedToInstant(clock: WallClock, timeZone: string): number | null {
  const naive = wallClockAsUtc(clock);
  const candidates = new Set<number>();
  for (const probe of [naive - 86_400_000, naive, naive + 86_400_000]) {
    candidates.add(naive - timeZoneOffsetMinutes(probe, timeZone) * 60_000);
  }
  const matches = [...candidates]
    .filter((instant) => wallClockAsUtc(wallClockAt(instant, timeZone)) === naive)
    .sort((a, b) => a - b);
  return matches[0] ?? null;
}

function dayMatches(cron: ParsedCron, year: number, month: number, day: number): boolean {
  if (!cron.months.has(month)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const domMatch = cron.daysOfMonth.has(day);
  const dowMatch = cron.daysOfWeek.has(weekday);
  if (cron.domRestricted && cron.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/** Look this many days ahead before giving up (covers Feb 29 schedules). */
const SEARCH_DAYS = 366 * 8;

/**
 * The next `count` instants strictly after `after` at which `expression`
 * fires in `timeZone`. Returns an empty list for invalid input.
 */
export function nextCronRuns(
  expression: string,
  timeZone: string,
  count: number,
  after: Date = new Date(),
): Date[] {
  const parsed = parseCron(expression);
  if (!parsed.ok || !isValidTimeZone(timeZone) || count <= 0) return [];
  const { cron } = parsed;
  const minutes = [...cron.minutes].sort((a, b) => a - b);
  const hours = [...cron.hours].sort((a, b) => a - b);
  const threshold = after.getTime();
  const start = wallClockAt(threshold, timeZone);
  const runs: Date[] = [];
  const seen = new Set<number>();
  // Walk calendar days in the zone's wall clock, starting a day early so a
  // DST shift around `after` cannot hide the first match.
  const firstDay = Date.UTC(start.year, start.month - 1, start.day) - 86_400_000;
  for (let i = 0; i < SEARCH_DAYS && runs.length < count; i += 1) {
    const date = new Date(firstDay + i * 86_400_000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!dayMatches(cron, year, month, day)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const instant = zonedToInstant({ year, month, day, hour, minute }, timeZone);
        if (instant === null || instant <= threshold || seen.has(instant)) continue;
        seen.add(instant);
        runs.push(new Date(instant));
        if (runs.length >= count) return runs;
      }
    }
  }
  return runs;
}

// ─── Form helpers ────────────────────────────────────────────────────

/** "9:05" + "PM" → { hour: 21, minute: 5 }; null when malformed. */
export function parseClockTime(
  text: string,
  meridiem: "AM" | "PM",
): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hour12 = Number(match[1]);
  const minute = Number(match[2]);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (meridiem === "PM" ? 12 : 0);
  return { hour, minute };
}

/** { hour: 21, minute: 5 } → { text: "9:05", meridiem: "PM" }. */
export function formatClockTime(
  hour: number,
  minute: number,
): { text: string; meridiem: "AM" | "PM" } {
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return {
    text: `${hour12}:${String(minute).padStart(2, "0")}`,
    meridiem: hour < 12 ? "AM" : "PM",
  };
}

/** "(GMT-06:00) America/Chicago" at `at`. */
export function timeZoneLabel(timeZone: string, at: Date = new Date()): string {
  const offset = timeZoneOffsetMinutes(at.getTime(), timeZone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `(GMT${sign}${hh}:${mm}) ${timeZone}`;
}

/** IANA zones the runtime knows about, with UTC first. */
export function listTimeZones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf?.("timeZone") ?? [];
  return ["UTC", ...supported.filter((zone) => zone !== "UTC")];
}

/** The browser's zone, falling back to UTC. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
