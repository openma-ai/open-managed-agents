#!/usr/bin/env node
/**
 * Console design-token gate (#502, epic #501).
 *
 * Measures two things in apps/console and compares them with checked-in
 * baselines under apps/console/token-gate/:
 *
 *   1. Token allowlist: every custom property name declared in the `:root`
 *      block of src/styles/console-tokens.css must be listed in
 *      token-allowlist.json. New names need Owner approval.
 *   2. Hardcode budget: the number of "should-token" hardcoded GUI values
 *      (CSS declarations, Tailwind arbitrary values in TS/TSX, inline
 *      style literals). Each file has a budget in hardcode-baseline.json.
 *      The budget is a ratchet: it only goes down. A cleanup PR lowers it in
 *      the same PR (`--update`); raising it requires Owner approval.
 *
 * With `--base <git-ref>` it also lists component files added since that ref
 * under src/components/ui/** or directly under src/components/ (top-level
 * wrappers). Each one must be listed in approved-components.json.
 *
 * The classifier rules are documented in apps/console/token-gate/README.md
 * and pinned by scripts/token-audit.test.mjs. Keep the three in sync.
 *
 * Usage (from the repo root):
 *   pnpm --filter managed-agents-console token-audit            # report
 *   pnpm --filter managed-agents-console token-audit -- --hits  # every hit
 *   pnpm --filter managed-agents-console token-audit -- --file src/styles/console-list.css
 *   pnpm --filter managed-agents-console token-audit:check      # CI gate
 *   pnpm --filter managed-agents-console token-audit:update     # lower budgets
 *   node apps/console/scripts/token-audit.mjs --check --base origin/main
 *
 * No dependencies: plain Node so CI can run it without `pnpm install`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CONSOLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TOKENS_FILE = "src/styles/console-tokens.css";
export const GATE_DIR = "token-gate";
export const ALLOWLIST_FILE = `${GATE_DIR}/token-allowlist.json`;
export const BASELINE_FILE = `${GATE_DIR}/hardcode-baseline.json`;
export const APPROVED_COMPONENTS_FILE = `${GATE_DIR}/approved-components.json`;
export const OWNER_APPROVAL_LABEL = "owner-approved:console-tokens";

export const CATEGORIES = ["css", "tsxArbitrary", "inlineStyle"];

// ---------------------------------------------------------------------------
// Literal detection (shared by CSS, Tailwind arbitrary values, inline style)
// ---------------------------------------------------------------------------

// Absolute and font-relative lengths. Viewport units (vh/vw/svh/dvh/…) and
// container units are layout ratios, like percentages, and are not counted in
// CSS. Time (ms/s), angles, `fr`, and unitless numbers are not GUI tokens.
const LENGTH_RE = /(?<![\w.#-])(-?)(\d*\.\d+|\d+)(px|rem|em|pt|pc|cm|mm|in|ch|ex)\b/g;
const HEX_RE = /(?<![\w&])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const COLOR_FN_RE = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[-\d.]/g;

/**
 * Return every hardcoded literal in a CSS value string.
 * @returns {{text: string, kind: "length"|"color", index: number}[]}
 */
export function findLiterals(value) {
  const out = [];
  for (const m of value.matchAll(LENGTH_RE)) out.push({ text: m[0], kind: "length", index: m.index });
  for (const m of value.matchAll(HEX_RE)) out.push({ text: m[0], kind: "color", index: m.index });
  for (const m of value.matchAll(COLOR_FN_RE)) out.push({ text: `${m[1]}(…)`, kind: "color", index: m.index });
  return out.sort((a, b) => a.index - b.index);
}

const OFFSCREEN_RE = /^-9999px$/;
const MASK_PROPS = /^(-webkit-)?mask(-image|-border(-source)?)?$/;
const MASK_COLORS = new Set(["#000", "#000000", "#fff", "#ffffff"]);

/**
 * Classify one literal as "ok" (allowed) or "should-token".
 * `prop` is the CSS property (or Tailwind utility family mapped to one).
 */
export function isOkLiteral(literal, prop) {
  const text = literal.text.toLowerCase();
  if (literal.kind === "length") {
    const n = Number.parseFloat(text);
    // `0` in any unit, and the 1px hairline (borders, outlines, insets).
    if (n === 0 || Math.abs(n) === 1 && text.endsWith("px")) return true;
    // Accessibility / honeypot offscreen positioning.
    if (OFFSCREEN_RE.test(text)) return true;
    // Tracking is font-relative by design.
    if (prop === "letter-spacing" && text.endsWith("em") && !text.endsWith("rem")) return true;
    return false;
  }
  // Mask stops: opaque black/white define alpha, not color.
  if (MASK_PROPS.test(prop) && MASK_COLORS.has(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// CSS scanner
// ---------------------------------------------------------------------------

/**
 * Split a stylesheet into declarations with their enclosing block preludes.
 * Comments are dropped; strings are kept verbatim. Lines are 1-based.
 * @returns {{prop: string, value: string, line: number, context: string[]}[]}
 */
export function parseCssDeclarations(source) {
  const decls = [];
  const stack = [];
  let buf = "";
  let bufLine = 1;
  let line = 1;
  let i = 0;
  const flushDecl = () => {
    const text = buf.trim();
    buf = "";
    if (!text || stack.length === 0) return;
    const colon = text.indexOf(":");
    if (colon <= 0 || text.startsWith("@")) return;
    const prop = text.slice(0, colon).trim().toLowerCase();
    if (!/^(--)?-?[a-z][a-z0-9-]*$/i.test(prop) && !prop.startsWith("--")) return;
    decls.push({ prop, value: text.slice(colon + 1).trim(), line: bufLine, context: [...stack] });
  };
  const startBuf = () => {
    if (buf.trim() === "") bufLine = line;
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let j = i; j < stop; j++) if (source[j] === "\n") line++;
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      startBuf();
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\") j++;
        j++;
      }
      buf += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "{") {
      stack.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
      i++;
      continue;
    }
    if (ch === "}") {
      flushDecl();
      stack.pop();
      i++;
      continue;
    }
    if (ch === ";") {
      flushDecl();
      i++;
      continue;
    }
    if (ch === "\n") line++;
    if (!/\s/.test(ch)) startBuf();
    buf += ch;
    i++;
  }
  return decls;
}

/** Every comma-separated selector in the innermost rule targets highlight.js. */
export function isHljsRule(context) {
  const selector = context[context.length - 1] ?? "";
  if (selector.startsWith("@")) return false;
  const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((s) => /\.hljs\b|\.hljs-/.test(s));
}

// `calc(var(--density-unit) * 9)` outside console-tokens.css is a 9px literal
// spelled through the scale unit; the named tokens are built this way, call
// sites should use the names.
const DENSITY_MULTIPLIER_RE = /var\(--density-unit\)\s*\*\s*(\d*\.?\d+)|(\d*\.?\d+)\s*\*\s*var\(--density-unit\)/g;

/**
 * Classify CSS declarations.
 *   in_token_def  – custom property definition (`--x: …`), any value. Except:
 *                   re-assigning a console-tokens.css token (`consoleTokens`)
 *                   to a hardcoded literal outside console-tokens.css is a
 *                   local override and counts as should-token.
 *   hljs          – literal colors in rules that only target highlight.js.
 *   ok            – no literal, or only allowed literals.
 *   should-token  – at least one literal that should be a token.
 *
 * @param {string} source
 * @param {{consoleTokens?: Set<string>, isTokenFile?: boolean}} [options]
 */
export function classifyCss(source, options = {}) {
  const consoleTokens = options.consoleTokens ?? new Set();
  const isTokenFile = options.isTokenFile ?? false;
  const results = [];
  let varDecls = 0;
  for (const decl of parseCssDeclarations(source)) {
    const literals = findLiterals(decl.value);
    if (!isTokenFile) {
      for (const m of decl.value.matchAll(DENSITY_MULTIPLIER_RE)) {
        literals.push({ text: `density-unit*${m[1] ?? m[2]}`, kind: "length", index: m.index, disguised: true });
      }
    }
    let kind;
    let bad = literals.filter((lit) => lit.disguised || !isOkLiteral(lit, decl.prop));
    if (decl.prop.startsWith("--")) {
      const override = !isTokenFile && consoleTokens.has(decl.prop) && bad.length > 0;
      kind = override ? "should-token" : "in_token_def";
      if (!override) bad = [];
    } else {
      if (decl.value.includes("var(--")) varDecls++;
      if (bad.length === 0) kind = "ok";
      else if (isHljsRule(decl.context)) kind = "hljs";
      else kind = "should-token";
    }
    results.push({ ...decl, kind, literals: bad.map((l) => l.text) });
  }
  return { decls: results, varLines: varDecls };
}

// ---------------------------------------------------------------------------
// TSX / TS scanner
// ---------------------------------------------------------------------------

// Tailwind arbitrary value: `<utility>-[<value>]`, optionally behind variants
// (`md:`, `hover:`, `after:`, …) and an important flag. A bracket group that
// is followed by `:` (or `/name:`) is a variant such as `data-[state=open]:`
// and is skipped. Values starting with `&`/`@` are selectors.
const ARBITRARY_RE = /(?<![\w\]-])((?:[!a-z0-9@/-]+:)*)(!?-?[a-z][a-z0-9-]*?)-\[([^\]\s"'`]+)\](\/[\w.-]+)?(?![:\w\]])/g;

// Utility families that never carry a GUI dimension or color.
const NON_VALUE_UTILITIES = /^(!?)(transition|content|will-change|font|grid-areas|animate|ease|z|order|cursor|list|aspect)$/;

/** Like findLiterals, but for Tailwind values (`_` is a space) and with % / viewport units. */
export function findArbitraryLiterals(value) {
  const v = value.replace(/_/g, " ");
  const out = [];
  const re = /(?<![\w.#-])(-?)(\d*\.\d+|\d+)(px|rem|em|pt|pc|cm|mm|in|ch|ex|%|vh|vw|svh|lvh|dvh|svw|lvw|dvw|vmin|vmax)(?![\w%])/g;
  for (const m of v.matchAll(re)) out.push({ text: m[0], kind: "length", index: m.index });
  for (const m of v.matchAll(HEX_RE)) out.push({ text: m[0], kind: "color", index: m.index });
  for (const m of v.matchAll(COLOR_FN_RE)) out.push({ text: `${m[1]}(…)`, kind: "color", index: m.index });
  return out;
}

/**
 * Classify Tailwind arbitrary values in a TS/TSX source.
 *   var           – value only references tokens (`[var(--x)]`, calc of vars).
 *   ok            – keyword / non-dimension value (`[inherit]`, transition lists, z-index).
 *   should-token  – value hardcodes a length, percentage, viewport size or color
 *                   and does not reference a token.
 *   mixed         – references a token *and* hardcodes a literal
 *                   (`rounded-[min(var(--radius-md),10px)]`). Reported, not budgeted.
 */
export function classifyTsxArbitrary(source) {
  const hits = [];
  const lines = lineIndex(source);
  for (const m of source.matchAll(ARBITRARY_RE)) {
    const [, , utility, value] = m;
    if (value.startsWith("&") || value.startsWith("@") || value.includes("=")) continue;
    const line = lineOf(lines, m.index);
    const token = m[0];
    const usesVar = value.includes("var(--") || /\(--[\w-]+\)/.test(value);
    const literals = findArbitraryLiterals(value);
    let kind;
    if (literals.length === 0) kind = usesVar ? "var" : "ok";
    else if (NON_VALUE_UTILITIES.test(utility.replace(/^-/, ""))) kind = "ok";
    else if (isGradientGeometry(utility, value, literals)) kind = "ok";
    else if (usesVar) kind = "mixed";
    else kind = "should-token";
    hits.push({ line, token, kind, literals: literals.map((l) => l.text) });
  }
  return hits;
}

/**
 * `bg-[length:250%_100%,auto]` / `bg-[position:…]`: percentages that size or
 * place a background gradient relative to its own box (shimmer sweep). They
 * are animation geometry, not GUI dimensions.
 */
function isGradientGeometry(utility, value, literals) {
  return (
    /^!?bg$/.test(utility) &&
    /^(length|position|size):/.test(value) &&
    literals.every((l) => l.text.endsWith("%"))
  );
}

/**
 * Inline style literals: string values inside JSX `style={{ … }}` objects
 * that hardcode a length or color (`containIntrinsicSize: "auto 48px"`,
 * `paddingRight: "0.75rem"`). Computed template literals (`${n}px`) and
 * numbers derived from props/constants are runtime geometry, not tokens.
 * Counted per property.
 */
export function classifyInlineStyles(source) {
  const hits = [];
  const lines = lineIndex(source);
  const re = /\bstyle=\{\{/g;
  for (const m of source.matchAll(re)) {
    const start = m.index + m[0].length;
    let depth = 2;
    let j = start;
    while (j < source.length && depth > 0) {
      const c = source[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      j++;
    }
    const body = source.slice(start, j - 2);
    const stringRe = /([\w$"'-]+)\s*:\s*(["'])((?:(?!\2).)*)\2/g;
    for (const p of body.matchAll(stringRe)) {
      const prop = p[1].replace(/["']/g, "");
      const literals = findLiterals(p[3]).filter((lit) => !isOkLiteral(lit, kebab(prop)));
      if (literals.length === 0) continue;
      hits.push({
        line: lineOf(lines, start + p.index),
        token: `${prop}: ${p[2]}${p[3]}${p[2]}`,
        kind: "should-token",
        literals: literals.map((l) => l.text),
      });
    }
  }
  return hits;
}

function kebab(prop) {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function lineIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Custom property names declared directly in `:root` of console-tokens.css. */
export function rootTokenNames(source) {
  const names = new Set();
  for (const decl of parseCssDeclarations(source)) {
    if (decl.context.length === 1 && decl.context[0] === ":root" && decl.prop.startsWith("--")) {
      names.add(decl.prop);
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "test", "mocks", "__tests__"]);
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function walk(dir, rel, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), `${rel}/${entry.name}`, out);
    } else out.push(`${rel}/${entry.name}`);
  }
  return out;
}

/** Source files measured by the gate, relative to apps/console. */
export function listSourceFiles(root = CONSOLE_ROOT) {
  const files = walk(path.join(root, "src"), "src", []).sort();
  return {
    css: files.filter((f) => f.endsWith(".css")),
    tsx: files.filter((f) => /\.(tsx|ts)$/.test(f) && !f.endsWith(".d.ts") && !TEST_FILE_RE.test(f)),
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Measure the console tree under `root`. Pure apart from reading files. */
export function audit(root = CONSOLE_ROOT) {
  const { css, tsx } = listSourceFiles(root);
  const read = (f) => readFileSync(path.join(root, f), "utf8");
  const files = {};
  const hits = [];
  const totals = { css: 0, tsxArbitrary: 0, inlineStyle: 0 };
  const allowed = { hljs: 0, inTokenDef: 0, tsxMixed: 0 };
  const health = { cssVarLines: 0, tsxVarArbitrary: 0 };
  const bump = (file, category) => {
    files[file] ??= { css: 0, tsxArbitrary: 0, inlineStyle: 0 };
    files[file][category]++;
    totals[category]++;
  };

  const tokenSource = existsSync(path.join(root, TOKENS_FILE)) ? read(TOKENS_FILE) : "";
  const tokens = rootTokenNames(tokenSource);
  const consoleTokens = new Set(tokens);

  for (const file of css) {
    const { decls, varLines } = classifyCss(read(file), { consoleTokens, isTokenFile: file === TOKENS_FILE });
    health.cssVarLines += varLines;
    for (const d of decls) {
      if (d.kind === "hljs") allowed.hljs++;
      if (d.kind === "in_token_def") allowed.inTokenDef++;
      if (d.kind === "hljs" || d.kind === "should-token") {
        hits.push({ file, line: d.line, category: "css", kind: d.kind, text: `${d.prop}: ${d.value}`, literals: d.literals });
      }
      if (d.kind === "should-token") bump(file, "css");
    }
  }
  for (const file of tsx) {
    const source = read(file);
    for (const h of classifyTsxArbitrary(source)) {
      if (h.kind === "var") health.tsxVarArbitrary++;
      if (h.kind === "mixed") {
        health.tsxVarArbitrary++;
        allowed.tsxMixed++;
      }
      if (h.kind === "should-token" || h.kind === "mixed") {
        hits.push({ file, line: h.line, category: "tsxArbitrary", kind: h.kind, text: h.token, literals: h.literals });
      }
      if (h.kind === "should-token") bump(file, "tsxArbitrary");
    }
    for (const h of classifyInlineStyles(source)) {
      hits.push({ file, line: h.line, category: "inlineStyle", kind: h.kind, text: h.token, literals: h.literals });
      bump(file, "inlineStyle");
    }
  }

  const total = totals.css + totals.tsxArbitrary + totals.inlineStyle;
  return { tokens, totals: { ...totals, total }, files: sortObject(files), hits, allowed, health };
}

function sortObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function fileTotal(counts) {
  return CATEGORIES.reduce((sum, c) => sum + (counts?.[c] ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

/**
 * Compare a measurement with the allowlist + baseline.
 * `raises` is the subset of errors that would grow the allowlist or a budget.
 * @returns {{errors: string[], notices: string[], raises: string[]}}
 */
export function compare(result, allowlist, baseline) {
  const errors = [];
  const notices = [];
  const raises = [];
  const raise = (message) => {
    errors.push(message);
    raises.push(message);
  };
  const allowed = new Set(allowlist.tokens);
  const current = new Set(result.tokens);

  const added = result.tokens.filter((t) => !allowed.has(t));
  for (const name of added) {
    raise(
      `New token \`${name}\` in ${TOKENS_FILE} :root is not on the allowlist (${allowlist.tokens.length} names). ` +
        `Owner approval needed: reuse an existing token, or ask the Owner and explain why the existing tokens are ` +
        `insufficient. After approval add it to ${ALLOWLIST_FILE} and label the PR \`${OWNER_APPROVAL_LABEL}\`.`,
    );
  }
  const removed = allowlist.tokens.filter((t) => !current.has(t));
  for (const name of removed) {
    errors.push(
      `Token \`${name}\` is on ${ALLOWLIST_FILE} but no longer declared in ${TOKENS_FILE} :root. ` +
        `The allowlist only shrinks: remove it in this PR (\`pnpm --filter managed-agents-console token-audit:update\`).`,
    );
  }

  for (const category of CATEGORIES) {
    const ceiling = baseline.ceiling?.[category];
    if (typeof ceiling === "number" && result.totals[category] > ceiling) {
      raise(
        `${category} should-token total ${result.totals[category]} exceeds the frozen ceiling ${ceiling} ` +
          `(${BASELINE_FILE}). Use an existing token from ${TOKENS_FILE}; raising the ceiling needs Owner approval.`,
      );
    }
  }
  if (typeof baseline.ceiling?.total === "number" && result.totals.total > baseline.ceiling.total) {
    raise(
      `should-token total ${result.totals.total} exceeds the frozen ceiling ${baseline.ceiling.total} (${BASELINE_FILE}).`,
    );
  }

  const fileNames = new Set([...Object.keys(result.files), ...Object.keys(baseline.files ?? {})]);
  const update = "`pnpm --filter managed-agents-console token-audit:update`";
  for (const file of [...fileNames].sort()) {
    const now = result.files[file] ?? {};
    const budget = baseline.files?.[file] ?? {};
    for (const category of CATEGORIES) {
      const n = now[category] ?? 0;
      const b = budget[category] ?? 0;
      if (n > b) {
        const lines = result.hits
          .filter((h) => h.file === file && h.category === category && h.kind === "should-token")
          .map((h) => `L${h.line}`)
          .join(", ");
        raise(
          `${file}: ${category} should-token ${n} > budget ${b} (hits: ${lines}). Replace the new hardcoded value(s) with ` +
            `existing tokens from ${TOKENS_FILE}. If no existing token fits, stop and ask the Owner; raising a budget ` +
            `needs Owner approval (label \`${OWNER_APPROVAL_LABEL}\`).`,
        );
      } else if (n < b) {
        errors.push(
          `${file}: ${category} should-token ${n} < budget ${b}. Nice — the budget is a ratchet, so lower it in this ` +
            `PR: run ${update} and commit ${BASELINE_FILE}.`,
        );
      }
    }
  }
  const budgetTotal = Object.values(baseline.files ?? {}).reduce((s, c) => s + fileTotal(c), 0);
  notices.push(`should-token ${result.totals.total} / budget ${budgetTotal} (ceiling ${baseline.ceiling?.total ?? "n/a"})`);
  return { errors, notices, raises };
}

/**
 * Compare checked-in gate files with the same files at the base ref. Growth
 * of the allowlist, a per-category budget, or the ceiling requires the Owner
 * approval label.
 */
export function compareWithBase({ allowlist, baseline, approved }, base, ownerApproved) {
  const errors = [];
  if (!base) return errors;
  const grew = [];
  if (base.approved && approved) {
    const before = new Set((base.approved.files ?? []).map((e) => e.file));
    const added = (approved.files ?? []).map((e) => e.file).filter((f) => !before.has(f));
    if (added.length) grew.push(`${APPROVED_COMPONENTS_FILE} approves ${added.join(", ")}`);
  }
  if (base.allowlist) {
    const before = new Set(base.allowlist.tokens);
    const added = allowlist.tokens.filter((t) => !before.has(t));
    if (added.length) grew.push(`${ALLOWLIST_FILE} adds ${added.map((t) => `\`${t}\``).join(", ")}`);
  }
  if (base.baseline) {
    const sum = (b, c) => Object.values(b.files ?? {}).reduce((s, f) => s + (f[c] ?? 0), 0);
    for (const c of CATEGORIES) {
      if (sum(baseline, c) > sum(base.baseline, c)) {
        grew.push(`${BASELINE_FILE} raises the ${c} budget ${sum(base.baseline, c)} → ${sum(baseline, c)}`);
      }
      const was = base.baseline.ceiling?.[c];
      const now = baseline.ceiling?.[c];
      if (typeof was === "number" && typeof now === "number" && now > was) {
        grew.push(`${BASELINE_FILE} raises the ${c} ceiling ${was} → ${now}`);
      }
    }
    const was = base.baseline.ceiling?.total;
    const now = baseline.ceiling?.total;
    if (typeof was === "number" && typeof now === "number" && now > was) {
      grew.push(`${BASELINE_FILE} raises the total ceiling ${was} → ${now}`);
    }
  }
  if (grew.length && !ownerApproved) {
    for (const g of grew) {
      errors.push(
        `${g}. The allowlist and budgets are a ratchet: raising them needs Owner approval (why are existing tokens ` +
          `insufficient?). After approval label the PR \`${OWNER_APPROVAL_LABEL}\`.`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// New component files (components/ui/** and top-level wrappers)
// ---------------------------------------------------------------------------

const UI_DIR = "src/components/ui/";
const TOP_DIR = "src/components/";
const DOMAIN_DIRS = new Set(["ai-elements", "session", "timeline"]);

/**
 * From added paths (relative to apps/console), pick component files that need
 * Owner approval: new primitives under components/ui/**, new top-level
 * wrappers directly under components/ (flagging same-name wrappers of a ui/
 * primitive), and files in a components/ subdirectory outside the fixed
 * domain dirs (ai-elements, session, timeline).
 */
export function newComponentFiles(addedFiles, uiBasenames = []) {
  const ui = new Set(uiBasenames.map((n) => n.toLowerCase()));
  const out = [];
  for (const file of addedFiles) {
    if (!file.startsWith(TOP_DIR)) continue;
    if (!/\.(tsx|ts|jsx|js|css)$/.test(file) || TEST_FILE_RE.test(file)) continue;
    if (file.startsWith(UI_DIR)) {
      out.push({ file, reason: "new primitive under components/ui/**" });
      continue;
    }
    const rest = file.slice(TOP_DIR.length);
    if (rest.includes("/")) {
      const dir = rest.split("/")[0];
      if (!DOMAIN_DIRS.has(dir)) out.push({ file, reason: `new component directory components/${dir}/ outside the fixed dirs` });
      continue;
    }
    const stem = rest.replace(/\.[^.]+$/, "");
    const kebabStem = stem.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    out.push({
      file,
      reason: ui.has(kebabStem) || ui.has(stem.toLowerCase())
        ? `new top-level wrapper with the same name as components/ui/${kebabStem}`
        : "new top-level component wrapper",
    });
  }
  return out;
}

export function checkNewComponents(found, approved) {
  const ok = new Set((approved.files ?? []).filter((e) => e.file && e.approval).map((e) => e.file));
  return found
    .filter((f) => !ok.has(f.file))
    .map(
      (f) =>
        `${f.file}: ${f.reason}. New components need Owner approval (fixed dirs: components/ui primitives, ` +
          `top-level shell/wrappers, domain under ai-elements/session/timeline). Checklist: [ ] Owner approved ` +
          `[ ] no existing primitive/wrapper fits [ ] uses existing tokens only [ ] screenshots for every importing ` +
          `route. Then add {"file", "approval", "reason"} to ${APPROVED_COMPONENTS_FILE}.`,
    );
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function addedSince(base, root) {
  const repoRoot = git(["rev-parse", "--show-toplevel"], root).trim();
  const prefix = path.relative(repoRoot, root).split(path.sep).join("/");
  // Merge base vs the working tree (committed + uncommitted), plus untracked
  // files, so a local run sees the same additions CI will.
  const mergeBase = git(["merge-base", base, "HEAD"], repoRoot).trim();
  const tracked = git(["diff", "--name-only", "--no-renames", "--diff-filter=A", mergeBase, "--", prefix], repoRoot);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", prefix], repoRoot);
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))]
    .sort()
    .map((p) => p.slice(prefix.length + 1));
}

function readAtRef(base, root, rel) {
  const repoRoot = git(["rev-parse", "--show-toplevel"], root).trim();
  const prefix = path.relative(repoRoot, root).split(path.sep).join("/");
  try {
    return JSON.parse(git(["show", `${base}:${prefix}/${rel}`], repoRoot));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Baseline files
// ---------------------------------------------------------------------------

export function buildBaseline(result, previous, { allowRaise = false } = {}) {
  // Keep every previously budgeted file/category, even at 0, so parallel
  // cleanup PRs only ever change their own count line (no merge conflicts
  // from deleted neighbours).
  const files = {};
  const names = new Set([...Object.keys(result.files), ...Object.keys(previous?.files ?? {})]);
  for (const file of names) {
    const counts = result.files[file] ?? {};
    const before = previous?.files?.[file] ?? {};
    const entry = {};
    for (const c of CATEGORIES) if (counts[c] || c in before) entry[c] = counts[c] ?? 0;
    if (Object.keys(entry).length) files[file] = entry;
  }
  // The ceiling is the frozen epic baseline (#501). It does not move with
  // cleanup PRs (that would make parallel PRs conflict on the same lines);
  // only an Owner-approved --allow-raise lifts it.
  const frozen = previous?.ceiling ?? { ...pick(result.totals, CATEGORIES), total: result.totals.total };
  const ceiling = allowRaise
    ? Object.fromEntries(
        [...CATEGORIES, "total"].map((k) => [k, Math.max(frozen[k] ?? 0, result.totals[k] ?? 0)]),
      )
    : frozen;
  return {
    $comment:
      "Ratchet. Generated by `pnpm --filter managed-agents-console token-audit:update`. Budgets only go down; " +
      "raising a file budget or the ceiling needs Owner approval. See token-gate/README.md.",
    ceiling,
    files: sortObject(files),
  };
}

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

function readJson(root, rel, fallback) {
  const p = path.join(root, rel);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback;
}

function writeJson(root, rel, value) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { check: false, update: false, json: false, hits: false, base: null, files: [], root: CONSOLE_ROOT, init: false, allowRaise: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    else if (a === "--check") args.check = true;
    else if (a === "--update") args.update = true;
    else if (a === "--init") args.init = true;
    else if (a === "--allow-raise") args.allowRaise = true;
    else if (a === "--json") args.json = true;
    else if (a === "--hits") args.hits = true;
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--file") args.files.push(argv[++i]);
    else if (a === "--root") args.root = path.resolve(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return args;
}

function printReport(result, { hits, files }) {
  const t = result.totals;
  console.log(`Console token audit (${path.relative(process.cwd(), CONSOLE_ROOT) || "."})`);
  console.log(`  tokens (${TOKENS_FILE} :root): ${result.tokens.length}`);
  console.log(`  should-token: ${t.total} = css ${t.css} + tsx arbitrary ${t.tsxArbitrary} + inline style ${t.inlineStyle}`);
  console.log(
    `  allowed (not budgeted): hljs ${result.allowed.hljs}, in_token_def ${result.allowed.inTokenDef}, ` +
      `tsx var+literal ${result.allowed.tsxMixed}`,
  );
  console.log(
    `  health: css declarations using var(--) ${result.health.cssVarLines}, tsx [var(--…)] ${result.health.tsxVarArbitrary}`,
  );
  console.log("");
  console.log("  per file (css / tsx arbitrary / inline = total):");
  const rows = Object.entries(result.files)
    .filter(([f]) => files.length === 0 || files.includes(f))
    .sort(([, a], [, b]) => fileTotal(b) - fileTotal(a));
  for (const [file, c] of rows) {
    console.log(
      `  ${String(fileTotal(c)).padStart(4)}  ${file}  (${c.css} / ${c.tsxArbitrary} / ${c.inlineStyle})`,
    );
  }
  if (hits || files.length) {
    console.log("");
    for (const h of result.hits) {
      if (files.length && !files.includes(h.file)) continue;
      const tag = h.kind === "should-token" ? h.category : `${h.category}:${h.kind}`;
      console.log(`  ${h.file}:${h.line}  [${tag}]  ${h.text}  {${h.literals.join(", ")}}`);
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    return 0;
  }
  const root = args.root;
  const result = audit(root);
  const allowlist = readJson(root, ALLOWLIST_FILE, null);
  const baseline = readJson(root, BASELINE_FILE, null);
  const approved = readJson(root, APPROVED_COMPONENTS_FILE, { files: [] });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result, args);
  }

  if (args.init || args.update) {
    if (args.update && (!allowlist || !baseline)) {
      console.error(`Missing ${ALLOWLIST_FILE} or ${BASELINE_FILE}; run with --init first.`);
      return 1;
    }
    if (args.update) {
      const { raises } = compare(result, allowlist, baseline);
      if (raises.length && !args.allowRaise) {
        console.error("\nRefusing to --update: it would raise a budget or add a token (Owner approval needed):");
        for (const e of raises) console.error(`  ✗ ${e}`);
        console.error(`  After Owner approval re-run with --allow-raise and label the PR \`${OWNER_APPROVAL_LABEL}\`.`);
        return 1;
      }
    }
    writeJson(root, ALLOWLIST_FILE, {
      $comment:
        "console-tokens.css :root names. Adding a name needs Owner approval (why are existing tokens insufficient?). " +
        "Removing is fine (token collapse, #514/#515).",
      tokens: args.init || args.allowRaise
        ? result.tokens
        : allowlist.tokens.filter((t) => result.tokens.includes(t)),
    });
    writeJson(root, BASELINE_FILE, buildBaseline(result, args.init ? null : baseline, { allowRaise: args.allowRaise }));
    console.log(`\nWrote ${ALLOWLIST_FILE} and ${BASELINE_FILE}.`);
    return 0;
  }

  if (!args.check) return 0;

  if (!allowlist || !baseline) {
    console.error(`Missing ${ALLOWLIST_FILE} or ${BASELINE_FILE}.`);
    return 1;
  }
  const { errors, notices } = compare(result, allowlist, baseline);
  if (args.base) {
    const ownerApproved = (process.env.TOKEN_GATE_LABELS ?? "").split(",").map((s) => s.trim()).includes(OWNER_APPROVAL_LABEL);
    const base = {
      allowlist: readAtRef(args.base, root, ALLOWLIST_FILE),
      baseline: readAtRef(args.base, root, BASELINE_FILE),
      approved: readAtRef(args.base, root, APPROVED_COMPONENTS_FILE),
    };
    errors.push(...compareWithBase({ allowlist, baseline, approved }, base, ownerApproved));
    const uiNames = existsSync(path.join(root, UI_DIR))
      ? readdirSync(path.join(root, UI_DIR)).map((f) => f.replace(/\.[^.]+$/, ""))
      : [];
    errors.push(...checkNewComponents(newComponentFiles(addedSince(args.base, root), uiNames), approved));
  }
  console.log("");
  for (const n of notices) console.log(`  ${n}`);
  if (errors.length) {
    console.error(`\nConsole token gate failed (${errors.length}):`);
    for (const e of errors) {
      console.error(`  ✗ ${e}`);
      if (process.env.GITHUB_ACTIONS) console.log(`::error title=Console token gate::${e}`);
    }
    return 1;
  }
  console.log("  Console token gate passed.");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
