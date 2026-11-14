/**
 * Unhandled rejections a platform leaks while running the scenarios.
 *
 * Vitest reports a rejection only when it is the sole `unhandledRejection`
 * listener (vitest/dist/chunks/init.*.js, listenForErrors → catchError). The
 * capture below becomes the second listener for the runner file, so it must
 * re-report everything it does not explicitly recognise: unknown rejections
 * are collected and `assertNoUnexpected()` fails the file in afterAll.
 *
 * Leaks are not part of the observation (they are not public output and their
 * count depends on retry timing); each declared signature names the product
 * file:line that leaks it so it can be fixed and deleted.
 */
export interface LeakSignature {
  /** Product file:line that leaks the rejection. */
  cause: string;
  matches(reason: unknown): boolean;
}

export interface LeakCapture {
  /** Absorbed rejections per declared signature cause. */
  absorbed(): Record<string, number>;
  /** Rejections no signature recognised. */
  unexpected(): string[];
  dispose(): void;
}

type ProcessLike = {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
};

function describe(reason: unknown): string {
  if (reason instanceof Error || (reason !== null && typeof reason === "object" && "message" in reason)) {
    const error = reason as { name?: string; message?: string; stack?: string };
    return `${error.name ?? "Error"}: ${error.message ?? ""}\n${String(error.stack ?? "").split("\n").slice(1, 4).join("\n")}`;
  }
  return String(reason);
}

/** Error-like reason with this name/message whose stack mentions every fragment. */
export function errorSignature(cause: string, shape: { name?: string; message: string; stack?: string[] }): LeakSignature {
  return {
    cause,
    matches(reason) {
      if (reason === null || typeof reason !== "object") return false;
      const error = reason as { name?: unknown; message?: unknown; stack?: unknown };
      if (error.message !== shape.message) return false;
      if (shape.name !== undefined && error.name !== shape.name) return false;
      const stack = String(error.stack ?? "");
      return (shape.stack ?? []).every((fragment) => stack.includes(fragment));
    },
  };
}

export function installLeakCapture(signatures: LeakSignature[]): LeakCapture {
  const processLike = (globalThis as { process?: ProcessLike }).process;
  if (processLike === undefined || typeof processLike.on !== "function") {
    throw new Error("platform-parity: no process.on(\"unhandledRejection\") in this runtime");
  }
  const absorbed = new Map<string, number>();
  const unexpected: string[] = [];
  const listener = (reason: unknown) => {
    const signature = signatures.find((candidate) => candidate.matches(reason));
    if (signature === undefined) unexpected.push(describe(reason));
    else absorbed.set(signature.cause, (absorbed.get(signature.cause) ?? 0) + 1);
  };
  processLike.on("unhandledRejection", listener);
  return {
    absorbed: () => Object.fromEntries([...absorbed].sort(([a], [b]) => a.localeCompare(b))),
    unexpected: () => [...unexpected],
    dispose: () => {
      processLike.off("unhandledRejection", listener);
    },
  };
}
