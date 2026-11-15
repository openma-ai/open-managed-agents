// The Session sandbox record in SessionDO storage (design §0.0b A.10).
// SessionDO is SQLite-backed, so the synchronous KV API is available: the
// version check and the write run in one synchronous step, and no other
// writer of this Durable Object can interleave between them.

import { stateVersion, type PortsSessionSandboxOptions, type SessionSandboxState } from "@open-managed-agents/session-runtime";

export type SessionSandboxStateStorage = Pick<DurableObjectStorage, "kv">;

export function durableObjectSandboxState(storage: SessionSandboxStateStorage, key: string): PortsSessionSandboxOptions<unknown>["state"] {
  const read = () => storage.kv.get(key) as SessionSandboxState | undefined;
  return {
    load: async () => read(),
    save: async (state, expected) => {
      if (stateVersion(read()) !== expected) return false;
      storage.kv.put(key, state);
      return true;
    },
  };
}
