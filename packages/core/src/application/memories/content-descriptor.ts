export interface DescribeMemoryContent {
  content: string | null;
}

export interface MemoryContentDescriptor {
  sha256: string;
  sizeBytes: number;
}

export interface MemoryContentDescriptorPort {
  describe(input: DescribeMemoryContent): Promise<MemoryContentDescriptor>;
}
