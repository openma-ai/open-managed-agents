/** Core identity for an MCP custom invocation. Transport request IDs and tool
 * arguments are deliberately absent from the identity. A transport retry that
 * has lost its receipt is a new *unbound* record, never an actionable call. */
export interface CustomInvocationScope {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  generation: number;
  holder: string;
  /** Canonical input/turn identity, retained across Work owner changes. */
  turnId: string;
  /** Production composition pins the canonical turn inspection to this CAS revision. */
  canonicalRevision?: number;
}
export interface CustomInvocation {
  receipt: string;
  name: string;
  arguments: Record<string, unknown>;
  nativeCallId: string | null;
  state: 'unbound' | 'pending' | 'resolved' | 'cancelled';
  result: { content: unknown[]; isError: boolean } | null;
  revision: number;
}
export interface CustomInvocationPersistence {
  create(scope: CustomInvocationScope, invocation: CustomInvocation): Promise<boolean>;
  read(scope: CustomInvocationScope, receipt: string): Promise<CustomInvocation | null>;
  /** Atomic revision CAS AND current Work authority check at commit. The
   * nativeCallId has a unique constraint within the canonical Session turn. */
  replace(scope: CustomInvocationScope, before: CustomInvocation, after: CustomInvocation): Promise<boolean>;
}

export class CustomInvocationConflict extends Error {
  constructor() { super('Custom invocation is unavailable, fenced, or conflicts with a committed transition'); }
}

/** No timers, open transport requests, or process-local pending maps own state.
 * External visibility begins only AFTER a receipt is bound to a native call.
 * This service does not execute external effects or manage sandbox lifecycle. */
export class CustomToolInvocations {
  constructor(private readonly persistence: CustomInvocationPersistence) {}

  async begin(scope: CustomInvocationScope, definition: { name: string }, args: Record<string, unknown>) {
    const invocation: CustomInvocation = {
      receipt: crypto.randomUUID(), name: definition.name, arguments: args,
      nativeCallId: null, state: 'unbound', result: null, revision: 1,
    };
    if (!await this.persistence.create(scope, invocation)) throw new CustomInvocationConflict();
    return invocation;
  }

  async read(scope: CustomInvocationScope, receipt: string) {
    const invocation = await this.persistence.read(scope, receipt);
    if (!invocation) throw new CustomInvocationConflict();
    return invocation;
  }

  async bind(scope: CustomInvocationScope, receipt: string, nativeCallId: string) {
    if (!nativeCallId || nativeCallId.length > 1024) throw new CustomInvocationConflict();
    return this.transition(scope, receipt, current => {
      if (current.nativeCallId === nativeCallId && current.state !== 'cancelled') return current;
      if (current.state !== 'unbound' || current.nativeCallId !== null) throw new CustomInvocationConflict();
      return { ...current, nativeCallId, state: 'pending' };
    });
  }

  /** Called only after canonical external-input admission. A disconnect of an
   * MCP request must NOT call this method or cancel the durable invocation. */
  async resolve(scope: CustomInvocationScope, receipt: string, nativeCallId: string, result: NonNullable<CustomInvocation['result']>) {
    return this.transition(scope, receipt, current => {
      if (current.nativeCallId !== nativeCallId) throw new CustomInvocationConflict();
      if (current.state === 'resolved' && JSON.stringify(current.result) === JSON.stringify(result)) return current;
      if (current.state !== 'pending') throw new CustomInvocationConflict();
      return { ...current, state: 'resolved', result };
    });
  }

  /** Cancellation is a canonical Core decision, not socket liveness. */
  async cancel(scope: CustomInvocationScope, receipt: string) {
    return this.transition(scope, receipt, current => {
      if (current.state === 'cancelled') return current;
      if (current.state === 'resolved') throw new CustomInvocationConflict();
      return { ...current, state: 'cancelled' };
    });
  }

  private async transition(scope: CustomInvocationScope, receipt: string, reduce: (value: CustomInvocation) => CustomInvocation) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await this.read(scope, receipt);
      const next = reduce(before);
      if (next === before) return before;
      const after = { ...next, revision: before.revision + 1 };
      if (await this.persistence.replace(scope, before, after)) return after;
    }
    throw new CustomInvocationConflict();
  }
}
