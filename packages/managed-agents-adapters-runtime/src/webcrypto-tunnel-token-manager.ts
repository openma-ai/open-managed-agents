import type {
  ManageTunnelTokenResult,
  RevealTunnelToken,
  RotateManagedTunnelToken,
  TunnelTokenManagerPort,
} from "@open-managed-agents/managed-agents-application";

export interface WebCryptoTunnelTokenManagerDependencies {
  rootSecret?: string;
  nextTokenId(): string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export class WebCryptoTunnelTokenManager implements TunnelTokenManagerPort {
  constructor(
    private readonly dependencies: WebCryptoTunnelTokenManagerDependencies,
  ) {}

  private async token(
    workspaceId: string,
    tunnelId: string,
    tokenId: string,
  ): Promise<ManageTunnelTokenResult> {
    const secret = this.dependencies.rootSecret;
    if (secret === undefined || secret.length === 0) {
      return {
        type: "unavailable",
        message: "Tunnel token derivation requires a platform root secret",
      };
    }
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${workspaceId}\u0000${tunnelId}\u0000${tokenId}`),
    );
    return {
      type: "available",
      token: {
        id: tokenId,
        token: `tnl_tok_${base64Url(new Uint8Array(signature))}`,
      },
    };
  }

  reveal(input: RevealTunnelToken): Promise<ManageTunnelTokenResult> {
    return this.token(
      input.workspaceId,
      input.tunnel.id,
      input.tunnel.connectorTokenId,
    );
  }

  rotate(input: RotateManagedTunnelToken): Promise<ManageTunnelTokenResult> {
    const nextTokenId = this.dependencies.nextTokenId();
    if (nextTokenId.length === 0) {
      return Promise.resolve({
        type: "unavailable",
        message: "Tunnel token identifier is empty",
      });
    }
    return this.token(input.workspaceId, input.tunnel.id, nextTokenId);
  }
}
