// Repository checkout for Session github_repository resources (design
// §0.7), shared by the Cloudflare SessionDO and the Node runner. A retained
// workspace keeps its clone (identity and pinned commit are verified, a Bond
// repository fetches new refs); a fresh one clones the default branch, sets a
// commit identity, then checks out the requested branch (created locally when
// the remote lacks it) or commit. Credentials never pass through here: the
// host's RepositoryAccessPort scopes them before the first git command.

import { DEFAULT_WORKSPACE_ROOT, workspaceRootOf, type SandboxExecutor } from "@open-managed-agents/sandbox";
import type { RepositoryMount } from "./session-resource-records";

export type RepositorySandbox = Pick<SandboxExecutor, "exec" | "readFile" | "gitCheckout" | "resolveWorkspaceRoot">;

/** How a host lets git reach its repositories. Runs once, before the first
 * clone, with every repository of the Session. */
export interface RepositoryAccessPort {
  prepare(repositories: readonly RepositoryMount[]): Promise<void>;
  /** This repository reaches git with no credential on this host. */
  anonymous?(repository: RepositoryMount): boolean;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Throws when a sandbox exec output reports a failure (`exit=N` prefix,
 * `[exit N]` suffix, or an `[error:`/`[exit signal=` marker). */
export function assertCommandSucceeded(command: string, output: string): void {
  const prefixedExit = /^exit=(-?\d+)/u.exec(output);
  const suffixedExit = /\[exit (?:exit=)?(-?\d+)\]/u.exec(output);
  const failed = (prefixedExit !== null && Number(prefixedExit[1]) !== 0)
    || (suffixedExit !== null && Number(suffixedExit[1]) !== 0)
    || output.includes("[error:")
    || output.includes("[exit signal=");
  if (failed) throw new Error(`Repository command failed: ${command}: ${output}`);
}

async function run(sandbox: RepositorySandbox, command: string, timeoutMs: number): Promise<string> {
  const output = await sandbox.exec(command, timeoutMs);
  assertCommandSucceeded(command, output);
  return output.replace(/^exit=0\n/u, "").trim();
}

/** A path as seen by `exec`, which runs in the workspace root. Only a
 * /workspace root may be a provider-mapped directory (local subprocess), so
 * only there is /workspace rewritten to a relative path; under an image
 * WORKDIR (ADR 0016) the absolute path is what readFile / gitCheckout use too. */
function execPath(value: string, workspaceRoot: string): string {
  if (workspaceRoot !== DEFAULT_WORKSPACE_ROOT) return value;
  if (value === "/workspace") return ".";
  return value.startsWith("/workspace/") ? value.slice("/workspace/".length) : value;
}

/** A real `.git/HEAD` always names a ref or a commit. */
async function retainedClone(sandbox: RepositorySandbox, mountPath: string): Promise<boolean> {
  try {
    return (await sandbox.readFile(`${mountPath}/.git/HEAD`)).trim().length > 0;
  } catch {
    return false;
  }
}

async function verifyRetained(sandbox: RepositorySandbox, repository: RepositoryMount, dir: string): Promise<void> {
  const remote = await run(sandbox, `git -C ${dir} remote get-url origin`, 30_000);
  if (remote !== repository.url) {
    throw new Error(
      `Retained repository at ${repository.mountPath} does not match Session resource ${repository.id ?? repository.url}: expected ${repository.url}, found ${remote || "no origin"}`,
    );
  }
  if (repository.checkout?.type === "commit") {
    await run(sandbox, `git -C ${dir} cat-file -e ${shellQuote(`${repository.checkout.sha}^{commit}`)}`, 30_000);
  }
  // A Bond-backed repository outlives a token: a long-lived Session sees tags
  // and branches pushed since it was cloned. The working tree is not touched.
  if (repository.credentialSource === "bond") {
    await run(sandbox, `git -C ${dir} fetch --quiet --tags --force --prune origin`, 120_000);
  }
}

async function clone(sandbox: RepositorySandbox, repository: RepositoryMount, dir: string): Promise<void> {
  if (sandbox.gitCheckout !== undefined) {
    await sandbox.gitCheckout(repository.url, { targetDir: repository.mountPath });
  } else {
    await run(sandbox, `git clone -- ${shellQuote(repository.url)} ${dir} 2>&1`, 120_000);
  }
}

async function cloneFresh(sandbox: RepositorySandbox, repository: RepositoryMount, dir: string, anonymous: boolean): Promise<void> {
  try {
    await clone(sandbox, repository, dir);
  } catch (err) {
    if (!anonymous) throw err;
    throw new Error(
      `Repository ${repository.url} has no token, so it was cloned anonymously and the clone failed. If it is private, attach it with an authorization_token: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await run(sandbox, `git -C ${dir} config user.name "Agent" && git -C ${dir} config user.email "agent@managed-agents.dev"`, 10_000);
  const checkout = repository.checkout;
  if (checkout?.type === "branch") {
    // DWIM creates a local tracking branch when origin/<name> exists; a
    // branch the remote lacks is created off the cloned default HEAD.
    const branch = shellQuote(checkout.name);
    await run(
      sandbox,
      `(git -C ${dir} fetch origin ${shellQuote(`${checkout.name}:refs/remotes/origin/${checkout.name}`)} 2>/dev/null && git -C ${dir} checkout ${branch}) || git -C ${dir} checkout -b ${branch}`,
      60_000,
    );
  } else if (checkout?.type === "commit") {
    await run(sandbox, `git -C ${dir} checkout --detach ${shellQuote(checkout.sha)}`, 60_000);
  }
}

export async function checkoutRepository(sandbox: RepositorySandbox, repository: RepositoryMount, anonymous = false): Promise<void> {
  const dir = shellQuote(execPath(repository.mountPath, await workspaceRootOf(sandbox)));
  if (await retainedClone(sandbox, repository.mountPath)) await verifyRetained(sandbox, repository, dir);
  else await cloneFresh(sandbox, repository, dir, anonymous);
}

/** RepositoryAccessPort for sandboxes that scope secrets to one command
 * prefix: each repository's token reaches only `git`, as an http
 * extraHeader in GIT_CONFIG_* env, never in a file or remote URL. An
 * `anonymous` repository gets no credential; git must not prompt for one. */
export function commandScopedRepositoryAccess(
  sandbox: Pick<SandboxExecutor, "registerCommandSecrets">,
  token: (repository: RepositoryMount) => Promise<string | null>,
  anonymous: (repository: RepositoryMount) => boolean = () => false,
): RepositoryAccessPort {
  return {
    anonymous,
    async prepare(all) {
      const repositories = all.filter((repository) => !anonymous(repository));
      const prompts: Record<string, string> = repositories.length < all.length ? { GIT_TERMINAL_PROMPT: "0" } : {};
      if (repositories.length === 0) {
        if (all.length > 0) sandbox.registerCommandSecrets?.("git", prompts);
        return;
      }
      if (sandbox.registerCommandSecrets === undefined) {
        throw new Error("Managed Session has GitHub repositories, but the selected sandbox cannot scope repository credentials");
      }
      const env: Record<string, string> = { ...prompts, GIT_CONFIG_COUNT: String(repositories.length) };
      for (const [index, repository] of repositories.entries()) {
        const value = await token(repository);
        if (value === null) {
          throw new Error(`Managed Session GitHub credential for resource ${repository.id ?? repository.url} was not found`);
        }
        env[`GIT_CONFIG_KEY_${index}`] = `http.${repository.url}.extraHeader`;
        env[`GIT_CONFIG_VALUE_${index}`] = `Authorization: Basic ${btoa(`x-access-token:${value}`)}`;
      }
      sandbox.registerCommandSecrets("git", env);
    },
  };
}
