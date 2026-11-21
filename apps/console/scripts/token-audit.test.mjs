// Classifier + gate tests for scripts/token-audit.mjs (#502).
// Run: pnpm --filter managed-agents-console test:token-audit
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOWLIST_FILE,
  APPROVED_COMPONENTS_FILE,
  BASELINE_FILE,
  CONSOLE_ROOT,
  OWNER_APPROVAL_LABEL,
  audit,
  buildBaseline,
  checkNewComponents,
  classifyCss,
  classifyInlineStyles,
  classifyTsxArbitrary,
  compare,
  compareWithBase,
  main,
  newComponentFiles,
  rootTokenNames,
} from "./token-audit.mjs";

const kinds = (decls) => decls.map((d) => `${d.prop}:${d.kind}`);

test("CSS: ok exceptions — 0, 1px hairlines, -9999px offscreen, letter-spacing em, mask #000, color-mix %", () => {
  const { decls } = classifyCss(`
    .a {
      margin: 0;
      border: 1px solid var(--border);
      box-shadow: inset 0 -1px 0 var(--border-chrome);
      top: -9999px;
      letter-spacing: -0.02em;
      mask-image: linear-gradient(#000 var(--x), transparent);
      background: color-mix(in srgb, var(--fg) 7%, transparent);
      width: 100%;
      height: 100svh;
      transition-duration: 0.01ms;
      font-weight: 560;
    }
  `);
  assert.deepEqual(new Set(decls.map((d) => d.kind)), new Set(["ok"]));
});

test("CSS: px / rem / em / pt / cm / hex / rgb literals are should-token", () => {
  const { decls } = classifyCss(`
    .a { gap: 6px; font-size: 0.875rem; padding: 0.4em; font-size: 11pt; color: #555; box-shadow: 0 0 0 rgb(0 0 0 / 0.1); }
    @page { margin: 1.5cm; }
  `);
  assert.deepEqual(decls.map((d) => d.kind), Array(7).fill("should-token"));
});

test("CSS: one count per declaration, not per literal", () => {
  const { decls } = classifyCss(".a { padding: 11px 14px; font-size: clamp(24px, 3vw, 34px); }");
  assert.equal(decls.filter((d) => d.kind === "should-token").length, 2);
});

test("CSS: literal fallbacks inside var() still count", () => {
  const { decls } = classifyCss(".a { box-shadow: var(--shadow-input-rest, 0 1px 2px rgb(0 0 0 / 0.06)); }");
  assert.equal(decls[0].kind, "should-token");
});

test("CSS: breakpoints in @media preludes and comments are not counted", () => {
  const { decls } = classifyCss(`
    /* width: 12px; */
    @media (max-width: 767px) { .a { padding: 0; } }
  `);
  assert.deepEqual(kinds(decls), ["padding:ok"]);
});

test("CSS: in_token_def for custom properties; re-assigning a console token to a literal is should-token", () => {
  const consoleTokens = new Set(["--detail-frame-inset"]);
  const source = `
    :root { --composer-radius: 16px; }
    @media (max-width: 640px) { :root { --detail-frame-inset: 18px; } }
    .b { --detail-frame-inset: var(--console-pad-xl); }
  `;
  assert.deepEqual(kinds(classifyCss(source, { consoleTokens }).decls), [
    "--composer-radius:in_token_def",
    "--detail-frame-inset:should-token",
    "--detail-frame-inset:in_token_def",
  ]);
  // Inside console-tokens.css itself every definition is in_token_def.
  assert.deepEqual(
    new Set(classifyCss(source, { consoleTokens, isTokenFile: true }).decls.map((d) => d.kind)),
    new Set(["in_token_def"]),
  );
});

test("CSS: var(--density-unit) * N outside console-tokens.css is a disguised literal", () => {
  const { decls } = classifyCss(".a { margin-top: calc(var(--density-unit) * 9); }");
  assert.equal(decls[0].kind, "should-token");
  assert.deepEqual(decls[0].literals, ["density-unit*9"]);
  const tokens = classifyCss(":root { --x: calc(var(--density-unit) * 9); }", { isTokenFile: true });
  assert.equal(tokens.decls[0].kind, "in_token_def");
});

test("CSS: hljs allow only when every selector targets highlight.js", () => {
  const { decls } = classifyCss(`
    .dark .hljs-comment, .dark .hljs-quote { color: #8b949e; }
    pre, code, .hljs { background: #f5f5f5 !important; }
  `);
  assert.deepEqual(kinds(decls), ["color:hljs", "background:should-token"]);
});

test("tokens: only direct :root names of console-tokens.css", () => {
  const names = rootTokenNames(`
    :root { --a: 1px; --b: var(--a); }
    .dark { --a: 2px; --dark-only: 0; }
    @media print { :root { --print-only: 0; } }
  `);
  assert.deepEqual(names, ["--a", "--b"]);
});

test("TSX: arbitrary values — variants/selectors skipped, var-only is health, literals are should-token", () => {
  const hits = classifyTsxArbitrary(`
    <div className="group-data-[state=open]:bg-bg [&_svg]:size-4 data-[slot=x]:p-0 h-[var(--control-h)]
      w-[420px] max-w-[40%] md:grid-cols-[200px_minmax(0,1fr)] text-[11px] bg-[#fff] max-h-[60vh]
      rounded-[min(var(--radius-md),10px)] transition-[width,height] z-[60] rounded-[inherit]
      grid-cols-[max-content_1fr] bg-[length:250%_100%,auto] tracking-[0.5em] gap-[1px]
      group-data-[orientation=horizontal]/tabs:after:bottom-[-5px]" />
  `);
  const by = (k) => hits.filter((h) => h.kind === k).map((h) => h.token);
  assert.deepEqual(by("var"), ["h-[var(--control-h)]"]);
  assert.deepEqual(by("mixed"), ["rounded-[min(var(--radius-md),10px)]"]);
  assert.deepEqual(by("should-token"), [
    "w-[420px]",
    "max-w-[40%]",
    "md:grid-cols-[200px_minmax(0,1fr)]",
    "text-[11px]",
    "bg-[#fff]",
    "max-h-[60vh]",
    "tracking-[0.5em]",
    "gap-[1px]",
    "tabs:after:bottom-[-5px]",
  ]);
  assert.deepEqual(by("ok"), [
    "transition-[width,height]",
    "z-[60]",
    "rounded-[inherit]",
    "grid-cols-[max-content_1fr]",
    "bg-[length:250%_100%,auto]",
  ]);
});

test("inline style: string literals count per property; computed geometry does not", () => {
  const hits = classifyInlineStyles(`
    <div style={{ containIntrinsicSize: "auto 48px", width: SIDE_PANEL_W }} />
    <div style={{ paddingLeft: \`\${0.75 + depth * 0.75}rem\`, paddingRight: "0.75rem" }} />
    <col style={{ width: "40%" }} />
    <i style={{ animationDelay: "180ms", border: "1px solid var(--border)" }} />
    <pre
      style={{
        containIntrinsicSize: "auto 200px",
        ...style,
      }}
    />
  `);
  assert.deepEqual(
    hits.map((h) => [h.line, h.token]),
    [
      [2, 'containIntrinsicSize: "auto 48px"'],
      [3, 'paddingRight: "0.75rem"'],
      [8, 'containIntrinsicSize: "auto 200px"'],
    ],
  );
});

const result = (over = {}) => ({
  tokens: ["--a", "--b"],
  totals: { css: 2, tsxArbitrary: 1, inlineStyle: 0, total: 3 },
  files: { "src/x.css": { css: 2, tsxArbitrary: 0, inlineStyle: 0 }, "src/y.tsx": { css: 0, tsxArbitrary: 1, inlineStyle: 0 } },
  hits: [
    { file: "src/x.css", line: 3, category: "css", kind: "should-token" },
    { file: "src/x.css", line: 9, category: "css", kind: "should-token" },
  ],
  ...over,
});
const allowlist = { tokens: ["--a", "--b"] };
const baseline = {
  ceiling: { css: 2, tsxArbitrary: 1, inlineStyle: 0, total: 3 },
  files: { "src/x.css": { css: 2 }, "src/y.tsx": { tsxArbitrary: 1 } },
};

test("gate: matching measurement passes", () => {
  assert.deepEqual(compare(result(), allowlist, baseline).errors, []);
});

test("gate: new token fails with Owner approval message", () => {
  const { errors, raises } = compare(result({ tokens: ["--a", "--b", "--new"] }), allowlist, baseline);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /`--new`.*Owner approval needed.*why the existing tokens are insufficient/);
  assert.equal(raises.length, 1);
});

test("gate: removed token must be dropped from the allowlist (ratchet down)", () => {
  const { errors, raises } = compare(result({ tokens: ["--a"] }), allowlist, baseline);
  assert.match(errors[0], /`--b`.*no longer declared/);
  assert.equal(raises.length, 0);
});

test("gate: count above budget or ceiling fails; below budget asks to lower it", () => {
  const over = result({
    totals: { css: 3, tsxArbitrary: 1, inlineStyle: 0, total: 4 },
    files: { ...result().files, "src/x.css": { css: 3, tsxArbitrary: 0, inlineStyle: 0 } },
  });
  const up = compare(over, allowlist, baseline);
  assert.ok(up.errors.some((e) => /src\/x\.css: css should-token 3 > budget 2 \(hits: L3, L9\)/.test(e)));
  assert.ok(up.errors.some((e) => /exceeds the frozen ceiling 2/.test(e)));
  assert.ok(up.errors.some((e) => /total 4 exceeds the frozen ceiling 3/.test(e)));

  const down = compare(
    result({ totals: { css: 1, tsxArbitrary: 1, inlineStyle: 0, total: 2 }, files: { ...result().files, "src/x.css": { css: 1 } } }),
    allowlist,
    baseline,
  );
  assert.equal(down.raises.length, 0);
  assert.match(down.errors[0], /css should-token 1 < budget 2.*lower it in this PR/);
});

test("gate: a new file with hardcodes fails (budget 0)", () => {
  const r = result({ files: { ...result().files, "src/new.tsx": { tsxArbitrary: 1 } } });
  assert.ok(compare(r, allowlist, baseline).errors.some((e) => /src\/new\.tsx: tsxArbitrary should-token 1 > budget 0/.test(e)));
});

test("gate: growing allowlist, budgets, ceiling or approvals vs the base ref needs the Owner label", () => {
  const raised = {
    allowlist: { tokens: ["--a", "--b", "--c"] },
    baseline: { ceiling: { ...baseline.ceiling, total: 4 }, files: { ...baseline.files, "src/x.css": { css: 3 } } },
    approved: { files: [{ file: "src/components/ui/new.tsx", approval: "x" }] },
  };
  const base = { allowlist, baseline, approved: { files: [] } };
  const errors = compareWithBase(raised, base, false);
  assert.equal(errors.length, 4);
  assert.ok(errors.every((e) => e.includes(OWNER_APPROVAL_LABEL)));
  assert.deepEqual(compareWithBase(raised, base, true), []);
  // Lowering is always fine.
  assert.deepEqual(compareWithBase({ allowlist, baseline: { ...baseline, files: { "src/x.css": { css: 1 } } } }, base, false), []);
});

test("components: new ui primitives, top-level wrappers and unknown dirs need approval", () => {
  const found = newComponentFiles(
    [
      "src/components/ui/fancy.tsx",
      "src/components/Tooltip.tsx",
      "src/components/StatusPill.tsx",
      "src/components/widgets/Thing.tsx",
      "src/components/session/NewPanel.tsx",
      "src/components/timeline/Lane.tsx",
      "src/components/Foo.test.tsx",
      "src/pages/NewPage.tsx",
    ],
    ["tooltip", "button"],
  );
  assert.deepEqual(
    found.map((f) => [f.file, f.reason]),
    [
      ["src/components/ui/fancy.tsx", "new primitive under components/ui/**"],
      ["src/components/Tooltip.tsx", "new top-level wrapper with the same name as components/ui/tooltip"],
      ["src/components/StatusPill.tsx", "new top-level component wrapper"],
      ["src/components/widgets/Thing.tsx", "new component directory components/widgets/ outside the fixed dirs"],
    ],
  );
  const errors = checkNewComponents(found, {
    files: [{ file: "src/components/StatusPill.tsx", approval: "https://github.com/openma-ai/open-managed-agents/issues/1" }, { file: "src/components/Tooltip.tsx" }],
  });
  assert.equal(errors.length, 3, "entries without an approval link do not count");
  assert.match(errors[0], /Owner approval.*Checklist/);
});

test("baseline: --update keeps zeroed entries and the frozen ceiling", () => {
  const next = buildBaseline(
    result({ files: { "src/y.tsx": { css: 0, tsxArbitrary: 1, inlineStyle: 0 } }, totals: { css: 0, tsxArbitrary: 1, inlineStyle: 0, total: 1 } }),
    baseline,
  );
  assert.deepEqual(next.files, { "src/x.css": { css: 0 }, "src/y.tsx": { tsxArbitrary: 1 } });
  assert.deepEqual(next.ceiling, baseline.ceiling);
});

test("CLI: fixture tree passes, then fails on a new token and a new hardcode", () => {
  const root = mkdtempSync(path.join(tmpdir(), "token-audit-"));
  try {
    mkdirSync(path.join(root, "src/styles"), { recursive: true });
    writeFileSync(path.join(root, "src/styles/console-tokens.css"), ":root { --a: 4px; }\n");
    writeFileSync(path.join(root, "src/app.css"), ".x { gap: var(--a); padding: 6px; }\n");
    const quiet = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
    try {
      assert.equal(main(["--root", root, "--init"]), 0);
      assert.equal(main(["--root", root, "--check"]), 0);
      const saved = JSON.parse(readFileSync(path.join(root, BASELINE_FILE), "utf8"));
      assert.deepEqual(saved.files, { "src/app.css": { css: 1 } });
      assert.deepEqual(JSON.parse(readFileSync(path.join(root, ALLOWLIST_FILE), "utf8")).tokens, ["--a"]);

      writeFileSync(path.join(root, "src/styles/console-tokens.css"), ":root { --a: 4px; --b: 8px; }\n");
      assert.equal(main(["--root", root, "--check"]), 1);
      assert.equal(main(["--root", root, "--update"]), 1, "--update refuses to add a token");
      writeFileSync(path.join(root, "src/styles/console-tokens.css"), ":root { --a: 4px; }\n");

      writeFileSync(path.join(root, "src/app.css"), ".x { gap: 3px; padding: 6px; }\n");
      assert.equal(main(["--root", root, "--check"]), 1);
      assert.equal(main(["--root", root, "--update"]), 1, "--update refuses to raise a budget");

      writeFileSync(path.join(root, "src/app.css"), ".x { gap: var(--a); padding: var(--a); }\n");
      assert.equal(main(["--root", root, "--check"]), 1, "stale budget must be lowered");
      assert.equal(main(["--root", root, "--update"]), 0);
      assert.equal(main(["--root", root, "--check"]), 0);
    } finally {
      console.log = quiet.log;
      console.error = quiet.error;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checked-in baseline matches the console tree (run token-audit:update after cleanup)", () => {
  const measured = audit(CONSOLE_ROOT);
  const allow = JSON.parse(readFileSync(path.join(CONSOLE_ROOT, ALLOWLIST_FILE), "utf8"));
  const base = JSON.parse(readFileSync(path.join(CONSOLE_ROOT, BASELINE_FILE), "utf8"));
  JSON.parse(readFileSync(path.join(CONSOLE_ROOT, APPROVED_COMPONENTS_FILE), "utf8"));
  assert.deepEqual(compare(measured, allow, base).errors, []);
});
