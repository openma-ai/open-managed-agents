declare module "*?raw" {
  const source: string;
  export default source;
}

interface ImportMeta {
  glob(
    pattern: string,
    options: { eager: true; import: string; query: string },
  ): Record<string, string>;
}
