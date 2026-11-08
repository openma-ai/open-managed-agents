import { describe, expect, it } from "vitest";
import {
  RetryableSandboxError,
  SandboxGoneError,
  type Acquired,
  type ResumeRef,
  type SandboxHandle,
  type SandboxLifecyclePort,
  type SandboxPlan,
  type TemplateRef,
} from "../src/index";

const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "work" };
const signal = new AbortController().signal;
const plan: SandboxPlan = {
  from: { image: "registry.example/image@sha256:abc" },
  egress: null,
  stores: [{ storeName: "notes", storeId: "ms_1", readOnly: false }],
  outputs: { bindingId: "out", mountPath: "/mnt/session/outputs" },
  idleMs: 300_000,
  labels: { workspaceId: "ws", sessionId: "sess" },
};

interface Box { id: string; state: "running" | "paused" | "deleted"; files: Map<string, string> }

/** Reference "changes" lifecycle: pause in place, snapshots for checkpoints. */
function inMemoryLifecycle(): SandboxLifecyclePort<Box> & { boxes: Map<string, Box>; snapshots: Map<string, Map<string, string>> } {
  const boxes = new Map<string, Box>();
  const snapshots = new Map<string, Map<string, string>>();
  let next = 0;
  const start = (files: Map<string, string>): Acquired<Box> => {
    const box: Box = { id: `box-${++next}`, state: "running", files: new Map(files) };
    boxes.set(box.id, box);
    return { runtime: box, handle: { provider: "memory", runtimeId: box.id } };
  };
  const live = (handle: SandboxHandle): Box => {
    const box = boxes.get(handle.runtimeId);
    if (box === undefined || box.state === "deleted") throw new SandboxGoneError(`sandbox ${handle.runtimeId} is gone`);
    return box;
  };
  return {
    handle: "changes",
    boxes,
    snapshots,
    async acquire({ plan }) {
      if ("template" in plan.from) {
        const template = snapshots.get(plan.from.template.ref);
        return template === undefined ? "gone" : start(template);
      }
      return start(new Map());
    },
    async attach({ handle }) {
      const box = boxes.get(handle.runtimeId);
      if (box === undefined || box.state === "deleted") return "gone";
      box.state = "running";
      return { runtime: box, handle };
    },
    async keepAlive({ handle }) {
      const box = boxes.get(handle.runtimeId);
      return box?.state === "running" ? "alive" : "gone";
    },
    async checkpoint({ handle }) {
      const box = live(handle);
      const ref = `snap-${++next}`;
      snapshots.set(ref, new Map(box.files));
      return { provider: "memory", ref, metadata: { kind: "snapshot" } };
    },
    async pause({ handle }) {
      live(handle).state = "paused";
      return { provider: "memory", ref: handle.runtimeId, metadata: { kind: "self" } };
    },
    async resume({ ref }) {
      if (ref.metadata?.kind === "self") {
        const box = boxes.get(ref.ref);
        if (box === undefined || box.state === "deleted") return "gone";
        box.state = "running";
        return { runtime: box, handle: { provider: "memory", runtimeId: box.id } };
      }
      const files = snapshots.get(ref.ref);
      return files === undefined ? "gone" : start(files);
    },
    async release({ handle }) {
      const box = boxes.get(handle.runtimeId);
      if (box !== undefined) box.state = "deleted";
    },
    async discard({ ref }) {
      if (ref.metadata?.kind === "self") return;
      snapshots.delete(ref.ref);
    },
    async snapshotTemplate({ handle }) {
      const box = live(handle);
      const ref = `tpl-${++next}`;
      snapshots.set(ref, new Map(box.files));
      return { provider: "memory", ref } satisfies TemplateRef;
    },
    async list() {
      return [...boxes.values()]
        .filter((box) => box.state !== "deleted")
        .map((box) => ({ handle: { provider: "memory", runtimeId: box.id }, labels: plan.labels, createdAt: "2026-11-08T00:00:00.000Z" }));
    },
  };
}

/** The core's acquisition order (§0.1 step 2): attach → resume → acquire. */
async function obtain(
  port: SandboxLifecyclePort<Box>,
  handle: SandboxHandle | null,
  ref: ResumeRef | null,
): Promise<Acquired<Box>> {
  if (handle !== null) {
    const attached = await port.attach({ scope, handle, signal });
    if (attached !== "gone") return attached;
  }
  if (ref !== null) {
    const resumed = await port.resume({ scope, ref, plan, signal });
    if (resumed !== "gone") return resumed;
  }
  const acquired = await port.acquire({ scope, plan, signal });
  if (acquired === "gone") throw new Error("template gone");
  return acquired;
}

describe("SandboxLifecyclePort contract", () => {
  it("reports not-found as \"gone\" and falls back attach → resume → acquire", async () => {
    const port = inMemoryLifecycle();
    const first = await obtain(port, null, null);
    first.runtime.files.set("/workspace/a.txt", "1");
    const ref = await port.checkpoint({ scope, runtime: first.runtime, handle: first.handle, signal });
    await port.release({ scope, handle: first.handle });

    expect(await port.attach({ scope, handle: first.handle, signal })).toBe("gone");
    expect(await port.keepAlive({ runtime: first.runtime, handle: first.handle })).toBe("gone");
    const restored = await obtain(port, first.handle, ref);
    expect(restored.handle.runtimeId).not.toBe(first.handle.runtimeId);
    expect(restored.runtime.files.get("/workspace/a.txt")).toBe("1");

    await port.discard({ scope, ref });
    expect(await port.resume({ scope, ref, plan, signal })).toBe("gone");
    const fresh = await obtain(port, first.handle, ref);
    expect(fresh.runtime.files.size).toBe(0);
  });

  it("pauses in place and discarding a self ref never deletes the sandbox", async () => {
    const port = inMemoryLifecycle();
    const acquired = await obtain(port, null, null);
    const ref = await port.pause({ scope, runtime: acquired.runtime, handle: acquired.handle, signal });
    await port.discard({ scope, ref });
    const resumed = await port.resume({ scope, ref, plan, signal });
    expect(resumed).not.toBe("gone");
    expect((resumed as Acquired<Box>).handle).toEqual(acquired.handle);
    await port.release({ scope, handle: acquired.handle });
    await port.release({ scope, handle: acquired.handle });
    expect(await port.list({ labels: { sessionId: "sess" }, signal })).toEqual([]);
  });

  it("acquires from a template and returns \"gone\" once it was discarded", async () => {
    const port = inMemoryLifecycle();
    const builder = await obtain(port, null, null);
    builder.runtime.files.set("/usr/lib/tool", "installed");
    const template = await port.snapshotTemplate({ runtime: builder.runtime, handle: builder.handle, signal });
    const fromTemplate = { ...plan, from: { template } };
    const first = await port.acquire({ scope, plan: fromTemplate, signal });
    const second = await port.acquire({ scope, plan: fromTemplate, signal });
    expect(first).not.toBe("gone");
    expect(second).not.toBe("gone");
    expect((first as Acquired<Box>).runtime.files.get("/usr/lib/tool")).toBe("installed");
    await port.discard({ scope, ref: template });
    expect(await port.acquire({ scope, plan: fromTemplate, signal })).toBe("gone");
  });

  it("throws typed errors for a vanished sandbox and for throttling", async () => {
    const port = inMemoryLifecycle();
    const acquired = await obtain(port, null, null);
    await port.release({ scope, handle: acquired.handle });
    await expect(port.checkpoint({ scope, runtime: acquired.runtime, handle: acquired.handle, signal }))
      .rejects.toBeInstanceOf(SandboxGoneError);

    const throttled = new RetryableSandboxError("rate limited", 1_500, { cause: new Error("429") });
    expect(throttled).toBeInstanceOf(Error);
    expect(throttled.name).toBe("RetryableSandboxError");
    expect(throttled.retryAfterMs).toBe(1_500);
    expect(new SandboxGoneError("x").name).toBe("SandboxGoneError");
  });
});
