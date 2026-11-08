/** A benchmark request the caller can fix (4xx) or an upstream source failure (502). */
export class EvalBenchmarkError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502 = 400) {
    super(message);
    this.name = "EvalBenchmarkError";
  }
}
