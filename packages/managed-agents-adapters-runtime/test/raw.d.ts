declare module "*?raw" {
  const source: string;
  export default source;
}

interface ImportMeta {
  glob(
    pattern: string,
    options?: Record<string, unknown>,
  ): Record<string, unknown>;
}
