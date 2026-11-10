// Exact transport refusal, not a successful model double or a catch-all fetch.
const key = Symbol.for("oma.test.parity-model-transport");
type Installed = { calls(): number; restore(): void };
export function installParityModelTransport(): Installed {
  const bag = globalThis as typeof globalThis & { [key]?: Installed };
  if (bag[key]) return bag[key]!;
  const original = globalThis.fetch;
  let count = 0;
  const wrapped: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "http://parity-model.invalid") return await original(input, init);
    if (url.pathname !== "/v1/messages" || !["", "?beta=true"].includes(url.search) || request.method !== "POST") throw new Error(`Unexpected parity model endpoint: ${request.method} ${url.pathname}${url.search}`);
    count++;
    throw new TypeError("parity model transport refused");
  };
  globalThis.fetch = wrapped;
  const installed = { calls: () => count, restore: () => { if (globalThis.fetch === wrapped) globalThis.fetch = original; delete bag[key]; } };
  bag[key] = installed;
  return installed;
}
