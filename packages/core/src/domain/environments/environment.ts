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
