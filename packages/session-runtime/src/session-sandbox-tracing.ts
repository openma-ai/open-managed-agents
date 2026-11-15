import type { LiveSessionSandbox } from "./session-sandbox-live";

/** Structural host port: the existing observability Tracer satisfies this
 * interface without importing its package into the Session sandbox core.
 * startActiveSpan propagates active context and owns span completion. */
export type SessionSandboxSpanAttributes = Record<string, string | number | boolean | undefined>;

export interface SessionSandboxSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attributes: SessionSandboxSpanAttributes): void;
  recordException(error: unknown): void;
  setStatus(status: { code: 0 | 1 | 2; message?: string }): void;
}

export interface SessionSandboxTracer {
  startActiveSpan<T>(
    name: string,
    run: (span: SessionSandboxSpan) => T | Promise<T>,
    options?: { attributes?: SessionSandboxSpanAttributes },
  ): T | Promise<T>;
}

const noopSpan: SessionSandboxSpan = {
  setAttribute() {},
  setAttributes() {},
  recordException() {},
  setStatus() {},
};
const noop: SessionSandboxTracer = {
  startActiveSpan: (_name, run) => run(noopSpan),
};
/** Active context belongs to the existing host Tracer. Never inspect commands,
 * plans, env, tokens, runtime objects or file bodies for telemetry. */
export async function traceSandboxOperation<T>(tracer: SessionSandboxTracer | undefined, name: string, attributes: SessionSandboxSpanAttributes, run: (span: SessionSandboxSpan) => Promise<T>): Promise<T> {
  return (tracer ?? noop).startActiveSpan(name, async span => {
    const started = performance.now();
    try {
      const result = await run(span);
      span.setStatus({ code: 1 });
      return result;
    } catch (error) {
      // SDK messages and stack first lines can contain request credentials or
      // response bodies. Preserve the ordered cause types and code locations,
      // not arbitrary message text. The original error is rethrown unchanged.
      const seen = new Set<unknown>();
      let cause = error;
      for (let depth = 0; cause !== undefined && !seen.has(cause) && depth < 8; depth++) {
        seen.add(cause);
        const safe = new Error(`Sandbox operation failed (cause ${depth})`);
        safe.name = cause instanceof Error && /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(cause.name) ? cause.name : "Error";
        // Only source locations without query strings/userinfo are permitted.
        safe.stack = (cause instanceof Error ? cause.stack?.split('\n').slice(1) : [])
          ?.filter(line => /^\s+at [A-Za-z0-9_.$ <>()[\]/:\\-]+:\d+:\d+\)?$/.test(line)).slice(0, 8).join('\n');
        span.recordException(safe);
        cause = cause instanceof Error ? cause.cause : undefined;
      }
      span.setStatus({ code: 2 });
      throw error;
    } finally {
      span.setAttribute("duration_ms", performance.now() - started);
      // startActiveSpan owns end(), matching the repository Node tracer.
    }
  }, { attributes });
}

export function traceSessionSandbox<R,T>(state: LiveSessionSandbox<R>, stage: string, run: (span: SessionSandboxSpan) => Promise<T>): Promise<T> {
  const scope = state.scope();
  return traceSandboxOperation(state.options.tracer, `session.sandbox.${stage}`, {
    "session.id": scope.sessionId, "work.id": scope.workId,
    "execution.generation": state.execution()?.generation,
    "execution.attempt_id": state.execution()?.attemptId,
    "environment.id": scope.environmentId,
  }, run);
}
