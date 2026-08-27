import type {
  ArchiveRegisteredTunnelCertificate,
  RegisterTunnelCertificate,
  RegisterTunnelCertificateResult,
  TunnelCertificateAuthorityPort,
} from "@open-managed-agents/managed-agents-application";

const BEGIN = "-----BEGIN CERTIFICATE-----";
const END = "-----END CERTIFICATE-----";

function occurrences(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

function hexadecimal(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class WebCryptoTunnelCertificateAuthority
  implements TunnelCertificateAuthorityPort
{
  async register(
    input: RegisterTunnelCertificate,
  ): Promise<RegisterTunnelCertificateResult> {
    const pem = input.caCertificatePem;
    if (
      pem.length > 8192 ||
      occurrences(pem, BEGIN) !== 1 ||
      occurrences(pem, END) !== 1 ||
      /-----BEGIN [^-]*PRIVATE KEY-----/u.test(pem)
    ) {
      return {
        type: "invalid",
        message: "CA certificate must contain one public certificate and no private key",
      };
    }
    const begin = pem.indexOf(BEGIN) + BEGIN.length;
    const end = pem.indexOf(END, begin);
    const encoded = pem.slice(begin, end).replace(/\s+/gu, "");
    let der: Uint8Array;
    try {
      const binary = atob(encoded);
      der = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      return { type: "invalid", message: "CA certificate PEM is not valid base64" };
    }
    if (der.length < 2 || der[0] !== 0x30) {
      return { type: "invalid", message: "CA certificate DER is invalid" };
    }
    const digest = await crypto.subtle.digest("SHA-256", der);
    return {
      type: "registered",
      expiresAt: null,
      fingerprint: hexadecimal(new Uint8Array(digest)),
    };
  }

  async archive(_input: ArchiveRegisteredTunnelCertificate): Promise<void> {}
}
