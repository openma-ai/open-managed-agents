import type {
  DescribeMemoryContent,
  MemoryContentDescriptor,
  MemoryContentDescriptorPort,
} from "@open-managed-agents/managed-agents-application";

function hexadecimal(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export class WebCryptoMemoryContentDescriptor
  implements MemoryContentDescriptorPort
{
  async describe(
    input: DescribeMemoryContent,
  ): Promise<MemoryContentDescriptor> {
    const bytes = new TextEncoder().encode(input.content ?? "");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      sha256: hexadecimal(new Uint8Array(digest)),
      sizeBytes: bytes.byteLength,
    };
  }
}
