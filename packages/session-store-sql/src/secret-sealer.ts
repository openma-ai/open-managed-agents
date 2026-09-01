export interface SessionResourceSecretSealer {
  seal(value: string): Promise<string>;
}
