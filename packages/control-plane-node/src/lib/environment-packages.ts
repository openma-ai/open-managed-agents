import {
  ENVIRONMENT_PACKAGE_PATHS,
  ensureEnvironmentPackages,
  hasEnvironmentPackages,
  parseExecResult,
  type EnvironmentPackages,
  type EnvironmentPackagesPath,
  type SandboxExecutor,
} from "@open-managed-agents/sandbox";

/** The part of an Environment this step reads. */
export interface PackagedEnvironment {
  readonly id: string;
  readonly config: { readonly type: string; readonly packages?: EnvironmentPackages };
  /** Selected catalog image; it scopes the setup markers to that image. */
  readonly openma?: { readonly sandboxImage?: string };
}

/**
 * Install a cloud Environment's `packages` into a fresh sandbox and put the
 * installed tools on PATH for every later command. A container that already
 * has them (same packages, same container or restored workspace) is left
 * alone. A failed install fails the session, as on Cloudflare: an agent
 * without the tools its Environment promises would fail later and less
 * clearly.
 */
export async function installEnvironmentPackages(
  sandbox: Pick<SandboxExecutor, "exec" | "setEnvVars">,
  environment: PackagedEnvironment,
  options: {
    pipIndexUrl?: string;
    log?: (result: { path: EnvironmentPackagesPath; durationMs: number }) => void;
  } = {},
): Promise<void> {
  const packages = environment.config.type === "cloud" ? environment.config.packages : undefined;
  if (!hasEnvironmentPackages(packages)) return;
  const sandboxImage = environment.openma?.sandboxImage;
  const result = await ensureEnvironmentPackages(sandbox, packages, undefined, {
    ...(options.pipIndexUrl ? { pipIndexUrl: options.pipIndexUrl } : {}),
    ...(sandboxImage !== undefined ? { sandboxImage } : {}),
  });
  if (result.error) {
    throw new Error(`Environment ${environment.id} setup failed at ${result.path}: ${result.error}`);
  }
  options.log?.(result);
  if (sandbox.setEnvVars === undefined) return;
  const current = parseExecResult(await sandbox.exec(`printf '%s' "$PATH"`, 15_000));
  const base = current.exitCode === 0 && current.stdout.trim() !== "" ? current.stdout.trim() : "/usr/local/bin:/usr/bin:/bin";
  const extra = ENVIRONMENT_PACKAGE_PATHS.filter((dir) => !base.split(":").includes(dir));
  await sandbox.setEnvVars({ PATH: [...extra, base].join(":") });
}
