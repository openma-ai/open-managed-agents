export type EnvironmentNetwork =
  | { type: "unrestricted" }
  | {
      type: "limited";
      allowMcpServers: boolean;
      allowPackageManagers: boolean;
      allowedHosts: string[];
    };

export interface EnvironmentPackages {
  apt: string[];
  cargo: string[];
  gem: string[];
  go: string[];
  npm: string[];
  pip: string[];
}

export type EnvironmentConfig =
  | {
      type: "cloud";
      networking: EnvironmentNetwork;
      packages: EnvironmentPackages;
    }
  | { type: "self_hosted" };

/** OpenMA-only Environment settings, carried on the wire as `_oma`. */
export interface EnvironmentOpenMaExtensions {
  /** Alias into the operator's SANDBOX_IMAGES catalog. Absent selects the
   * deployment default image. Never a raw provider image reference. */
  sandboxImage?: string;
  /** Attach this `self_hosted` Environment to an existing OpenMA Runtime
   * (a paired machine, `/v1/oma/runtimes`) instead of provisioning a
   * sandbox. The Runtime stays a peer resource; this is only a reference. */
  runtime?: EnvironmentRuntimeAttachment;
}

export interface EnvironmentRuntimeAttachment {
  runtimeId: string;
  /** Plain (non-secret) env overlay injected into the host runner's
   * shell/MCP/plugin processes for sessions on this Environment. */
  env: Record<string, string>;
}

export interface Environment {
  id: string;
  archivedAt: string | null;
  config: EnvironmentConfig;
  createdAt: string;
  description: string | null;
  metadata: Record<string, string>;
  name: string;
  updatedAt: string;
  scope?: "organization" | "account";
  openma?: EnvironmentOpenMaExtensions;
}
