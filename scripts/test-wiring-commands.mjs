/**
 * Test wiring gate, half 1: what does CI run? (design §0.7 测试门禁)
 *
 * Statically expands the `run:` steps of a GitHub workflow into the
 * test-runner calls they end up making. Root and package scripts are followed
 * through `pnpm [--filter <selector>] [run|exec] ...`, `npx`, `cd`,
 * `bash -c`, env prefixes and the here-string command loop CI uses for
 * domain-scoped tests. Each call is one of
 *
 *   { runner: "vitest",     dir, args }   vitest [run] ...
 *   { runner: "node-test",  dir, args }   node|tsx [...] --test <files/globs>
 *   { runner: "file",       dir, args }   node|tsx <file>
 *   { runner: "playwright", dir, args }   playwright test ...
 *
 * with `via`, the CI step and script chain that reached it. Whatever this
 * cannot follow (a filter that matches nothing, a missing script, an
 * orchestrator mode it does not model) is reported as a problem, never
 * silently skipped. Pure: no process spawning, only manifest reads.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

/** Root manifest plus every apps/* and packages/* workspace package. */
export function readWorkspace(root) {
  const manifest = (dir) => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  const rootManifest = manifest(".");
  const packages = new Map();
  for (const group of ["apps", "packages"]) {
    if (!existsSync(join(root, group))) continue;
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const dir = `${group}/${entry.name}`;
      if (!entry.isDirectory() || !existsSync(join(root, dir, "package.json"))) continue;
      const pkg = manifest(dir);
      if (typeof pkg.name === "string") packages.set(pkg.name, { name: pkg.name, dir, scripts: pkg.scripts ?? {} });
    }
  }
  return { root: { name: rootManifest.name ?? "root", dir: ".", scripts: rootManifest.scripts ?? {} }, packages };
}

/**
 * Steps of a workflow, from the subset of YAML GitHub workflows use here:
 * `jobs:` → `<job>:` → `steps:` → `- name|uses|run`, with `env:` maps and
 * `run:` as an inline or block (`|`, `>`) scalar.
 */
export function workflowSteps(text) {
  const lines = text.split(/\r?\n/u);
  const indentOf = (line) => line.length - line.trimStart().length;
  const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/u, "$2");
  const steps = [];
  let job = null;
  let stepsIndent = null;
  let step = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    const jobMatch = /^ {2}([\w-]+):\s*$/u.exec(line);
    if (jobMatch) {
      job = jobMatch[1];
      stepsIndent = null;
      step = null;
      continue;
    }
    if (/^\s+steps:\s*$/u.test(line)) {
      stepsIndent = indent;
      step = null;
      continue;
    }
    if (stepsIndent === null || indent <= stepsIndent) {
      if (stepsIndent !== null && indent <= stepsIndent) stepsIndent = null;
      continue;
    }
    const item = /^(\s*)- ([\w-]+):\s*(.*)$/u.exec(line);
    let keyIndent;
    let key;
    let value;
    if (item && item[1].length === stepsIndent + 2) {
      step = { job, name: null, env: {}, run: null };
      steps.push(step);
      keyIndent = indent + 2;
      [, , key, value] = item;
    } else {
      const field = /^(\s*)([\w-]+):\s*(.*)$/u.exec(line);
      if (!step || !field || field[1].length !== step.keyIndent) continue;
      keyIndent = field[1].length;
      [, , key, value] = field;
    }
    step.keyIndent = keyIndent;
    const block = () => {
      const body = [];
      while (index + 1 < lines.length && (lines[index + 1].trim() === "" || indentOf(lines[index + 1]) > keyIndent)) {
        body.push(lines[index + 1]);
        index += 1;
      }
      const margin = Math.min(...body.filter((l) => l.trim() !== "").map(indentOf));
      return body.map((l) => l.slice(Number.isFinite(margin) ? margin : 0)).join("\n").trimEnd();
    };
    if (key === "name") step.name = unquote(value);
    else if (key === "run") step.run = /^[|>][-+]?$/u.test(value.trim()) ? block() : unquote(value);
    else if (key === "env" && value.trim() === "") {
      for (const entry of block().split("\n")) {
        const pair = /^([\w-]+):\s*(.*)$/u.exec(entry.trim());
        if (pair) step.env[pair[1]] = unquote(pair[2]);
      }
    }
  }
  return steps.map(({ keyIndent: _keyIndent, ...rest }) => rest);
}

/** `${{ needs.<job>.outputs.<name> }}` from `outputs`; any other expression is empty. */
export function substituteExpressions(text, outputs) {
  return text
    .replace(/\$\{\{\s*needs\.[\w-]+\.outputs\.([\w-]+)\s*\}\}/gu, (_match, name) => outputs[name] ?? "")
    .replace(/\$\{\{[^}]*\}\}/gu, "");
}

/** Shell words grouped into simple commands (split on && || ; | & newline and parentheses). */
export function shellSegments(text) {
  const segments = [];
  let words = [];
  let word = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && text[index + 1] === "\n") {
      index += 1;
    } else if (char === "'") {
      const end = text.indexOf("'", index + 1);
      const stop = end === -1 ? text.length : end;
      word = (word ?? "") + text.slice(index + 1, stop);
      index = stop;
    } else if (char === '"') {
      let value = "";
      let cursor = index + 1;
      while (cursor < text.length && text[cursor] !== '"') {
        if (text[cursor] === "\\" && cursor + 1 < text.length) {
          value += text[cursor + 1];
          cursor += 2;
        } else {
          value += text[cursor];
          cursor += 1;
        }
      }
      word = (word ?? "") + value;
      index = cursor;
    } else if (char === "#" && word === null) {
      while (index + 1 < text.length && text[index + 1] !== "\n") index += 1;
    } else if (char === "\n" || char === ";" || char === "(" || char === ")") {
      endSegment();
    } else if (char === "&" || char === "|") {
      endSegment();
      if (text[index + 1] === char) index += 1;
    } else if (char === " " || char === "\t" || char === "\r") {
      endWord();
    } else {
      word = (word ?? "") + char;
    }
  }
  endSegment();
  return segments;
}

// `while IFS= read -r cmd; do ... bash -c "$cmd" ... done <<< "$LIST"`: each
// line of $LIST is a command (CI's domain-scoped test step).
const HERE_STRING_LOOP = /while\b[^\n]*\bread\s+(?:-r\s+)?(\w+)[\s\S]*?\bdone\s*<<<\s*"?\$\{?(\w+)\}?"?/gu;

function inlineHereStringLoops(text, env) {
  return text.replace(HERE_STRING_LOOP, (loop, variable, source) =>
    new RegExp(`\\b(?:bash|sh)\\s+-c\\s+"?\\$\\{?${variable}\\b`, "u").test(loop) ? `\n${env[source] ?? ""}\n` : loop);
}

const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "time", "exec", "!"]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/u;
const PNPM_BUILTINS = new Set([
  "add", "approve-builds", "audit", "bin", "c", "config", "create", "deploy", "dlx", "doctor", "env",
  "fetch", "i", "import", "init", "install", "licenses", "link", "list", "ln", "ls", "outdated", "pack",
  "patch", "patch-commit", "prune", "publish", "rb", "rebuild", "remove", "rm", "root", "self-update",
  "server", "setup", "store", "uninstall", "unlink", "up", "update", "upgrade", "why",
]);
const NODE_VALUE_FLAGS = new Set([
  "--conditions", "--env-file", "--experimental-loader", "--import", "--input-type", "--loader", "--require",
  "--test-concurrency", "--test-name-pattern", "--test-reporter", "--test-reporter-destination",
  "--test-skip-pattern", "--tsconfig", "-C", "-r",
]);

/**
 * Expand one CI step (or any command string) into runner calls.
 * `orchestrators` maps a repo-relative script path to (env) => commands
 * (string[]), or null when the mode reached is not modelled.
 */
export function expandCiStep(step, workspace, { outputs = {}, orchestrators = {} } = {}) {
  const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, substituteExpressions(v, outputs)]));
  const sink = { calls: [], problems: [], seen: new Set(), workspace, orchestrators };
  const label = `${step.job ?? "?"} › ${step.name ?? step.run?.split("\n")[0] ?? "?"}`;
  expand(substituteExpressions(step.run ?? "", outputs), {
    dir: ".", scripts: workspace.root.scripts, exactTarget: true, env, via: [label], depth: 0,
  }, sink);
  return { calls: sink.calls, problems: sink.problems };
}

function expand(text, context, sink) {
  if (context.depth > 25) {
    sink.problems.push({ via: context.via, message: "script expansion is too deep (cycle?)" });
    return;
  }
  const cursor = { ...context };
  for (const words of shellSegments(inlineHereStringLoops(text, context.env))) interpret(words, cursor, sink);
}

function interpret(words, context, sink) {
  let start = 0;
  const env = { ...context.env };
  while (start < words.length && (SHELL_KEYWORDS.has(words[start]) || ASSIGNMENT.test(words[start]))) {
    if (ASSIGNMENT.test(words[start])) {
      const eq = words[start].indexOf("=");
      env[words[start].slice(0, eq)] = words[start].slice(eq + 1);
    }
    start += 1;
  }
  const [command, ...args] = words.slice(start);
  const here = { ...context, env };
  switch (command) {
    case undefined:
      return;
    case "cd":
      context.dir = posix.normalize(posix.join(context.dir, args[0] ?? "."));
      return;
    case "pnpm":
      pnpm(args, here, sink);
      return;
    case "npx":
      interpret(args.filter((arg, index) => !(arg.startsWith("-") && index === 0)), here, sink);
      return;
    case "bash":
    case "sh":
      if (args[0] === "-c" && args[1] !== undefined) expand(args[1], { ...here, depth: here.depth + 1 }, sink);
      return;
    case "vitest":
      vitest(args, here, sink);
      return;
    case "node":
    case "tsx":
      nodeLike(args, here, sink);
      return;
    case "playwright":
      if (args[0] === "test") sink.calls.push({ runner: "playwright", dir: here.dir, args: args.slice(1), via: here.via });
      return;
    default:
  }
}

function vitest(args, context, sink) {
  const [mode, ...rest] = args;
  if (["list", "bench", "typecheck", "init", "related"].includes(mode)) return;
  const runArgs = ["run", "watch", "dev"].includes(mode) ? rest : args;
  sink.calls.push({ runner: "vitest", dir: context.dir, args: runArgs, via: context.via });
}

function nodeLike(args, context, sink) {
  let test = false;
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--test") test = true;
    else if (["-e", "--eval", "-p", "--print"].includes(arg)) return;
    else if (arg.startsWith("-")) {
      if (NODE_VALUE_FLAGS.has(arg)) index += 1;
    } else {
      positionals.push(arg);
      if (!test) break;
    }
  }
  if (test) {
    sink.calls.push({ runner: "node-test", dir: context.dir, args: positionals, via: context.via });
    return;
  }
  if (positionals.length === 0) return;
  const file = posix.normalize(posix.join(context.dir, positionals[0]));
  sink.calls.push({ runner: "file", dir: context.dir, args: [positionals[0]], via: context.via });
  const orchestrator = sink.orchestrators[file];
  if (orchestrator === undefined) return;
  const commands = orchestrator(context.env);
  if (commands === null) {
    sink.problems.push({ via: context.via, message: `${file}: this orchestrator mode is not modelled by scripts/test-wiring-commands.mjs` });
    return;
  }
  const root = sink.workspace.root;
  for (const command of commands) {
    expand(command, { ...context, dir: ".", scripts: root.scripts, via: [...context.via, file], depth: context.depth + 1 }, sink);
  }
}

function pnpm(args, context, sink) {
  const filters = [];
  let recursive = false;
  let index = 0;
  for (; index < args.length && args[index].startsWith("-"); index += 1) {
    const arg = args[index];
    if (arg === "--filter" || arg === "-F") filters.push(args[++index]);
    else if (arg.startsWith("--filter=")) filters.push(arg.slice("--filter=".length));
    else if (arg === "-r" || arg === "--recursive") recursive = true;
    else if (arg === "-C" || arg === "--dir") {
      sink.problems.push({ via: context.via, message: `pnpm ${arg} is not modelled` });
      return;
    }
  }
  const [command, ...rest] = args.slice(index);
  if (command === undefined || PNPM_BUILTINS.has(command)) return;
  let targets = [{ dir: context.dir, scripts: context.scripts, label: context.label, exact: context.exactTarget }];
  if (filters.length > 0 || recursive) {
    targets = filters.length > 0 ? selectPackages(filters, context, sink) : [...sink.workspace.packages.values()].map((p) => ({ ...p, exact: false }));
    targets = targets.map((p) => ({ dir: p.dir, scripts: p.scripts, label: p.name, exact: p.exact }));
  }
  for (const target of targets) {
    const targetContext = { ...context, dir: target.dir, scripts: target.scripts, label: target.label, exactTarget: target.exact };
    if (command === "exec") {
      interpret(rest, targetContext, sink);
      continue;
    }
    const isRun = command === "run" || command === "run-script";
    const script = isRun ? rest[0] : ["t", "tst"].includes(command) ? "test" : command;
    const extra = (isRun ? rest.slice(1) : rest).filter((arg, i) => !(i === 0 && arg === "--"));
    if (script === undefined) continue;
    if (target.scripts[script] === undefined) {
      if (!isRun && !["test", "start"].includes(script) && filters.length === 0) {
        interpret([script, ...extra], targetContext, sink);
      } else if (target.exact) {
        sink.problems.push({ via: context.via, message: `${target.label ?? "root"}: no "${script}" script` });
      }
      continue;
    }
    const key = `${target.dir}\0${script}\0${extra.join(" ")}`;
    if (sink.seen.has(key)) continue;
    sink.seen.add(key);
    const body = [target.scripts[script], ...extra.map(shellQuote)].join(" ");
    expand(body, { ...targetContext, via: [...context.via, `${target.label ?? "root"} ${script}`], depth: context.depth + 1 }, sink);
  }
}

function shellQuote(arg) {
  return /^[\w@%+=:,./-]+$/u.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/** pnpm --filter selectors: exact name, name glob (*), or ./dir and {dir}. */
export function selectPackages(selectors, context, sink) {
  const selected = new Map();
  for (const selector of selectors) {
    if (selector === undefined || /\.\.\.|\[|\^/u.test(selector)) {
      sink.problems.push({ via: context.via, message: `pnpm --filter ${selector}: selector form is not modelled` });
      continue;
    }
    const directory = /^\{(.+)\}$/u.exec(selector)?.[1] ?? (selector.startsWith(".") ? selector : null);
    const exact = directory !== null || !selector.includes("*");
    const pattern = new RegExp(`^${selector.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u");
    const matches = [...sink.workspace.packages.values()].filter((pkg) =>
      directory !== null ? pkg.dir === posix.normalize(posix.join(context.dir, directory)) : pattern.test(pkg.name));
    if (matches.length === 0) {
      sink.problems.push({ via: context.via, message: `pnpm --filter ${selector} matches no workspace package` });
    }
    for (const pkg of matches) {
      const previous = selected.get(pkg.name);
      selected.set(pkg.name, { ...pkg, exact: exact || previous?.exact === true });
    }
  }
  return [...selected.values()];
}
