import type {
  ArchiveProvisionedTunnel,
  ProvisionTunnel,
  ProvisionTunnelResult,
  TunnelProvisionerPort,
} from "@open-managed-agents/managed-agents-application";

export interface LocalTunnelProvisionerDependencies {
  domainSuffix: string;
  nextTokenId(): string;
}

export class LocalTunnelProvisioner implements TunnelProvisionerPort {
  constructor(
    private readonly dependencies: LocalTunnelProvisionerDependencies,
  ) {}

  async provision(input: ProvisionTunnel): Promise<ProvisionTunnelResult> {
    const suffix = this.dependencies.domainSuffix.replace(/^\.+|\.+$/gu, "");
    const tokenId = this.dependencies.nextTokenId();
    if (suffix.length === 0 || input.tunnelId.length === 0 || tokenId.length === 0) {
      return {
        type: "rejected",
        message: "Local Tunnel provisioning configuration is incomplete",
      };
    }
    return {
      type: "provisioned",
      domain: `${input.tunnelId}.${suffix}`,
      connectorTokenId: tokenId,
    };
  }

  async archive(_input: ArchiveProvisionedTunnel): Promise<void> {}
}
