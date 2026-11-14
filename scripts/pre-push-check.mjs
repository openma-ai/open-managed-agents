import { spawnSync } from "node:child_process";

const checks = [
  ["whitespace", ["git", "diff", "--check"]],
  ["typecheck", ["pnpm", "exec", "tsc", "--noEmit"]],
  ["test wiring", ["node", "scripts/check-test-wiring.mjs"]],
  ["architecture", ["pnpm", "run", "test:architecture"]],
];

for (const [name, command] of checks) {
  console.log(`[pre-push] ${name}`);
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[pre-push] ${name} failed`);
    process.exit(result.status ?? 1);
  }
}

console.log("[pre-push] all checks passed");
