import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  declarePersistenceCapabilities,
  openSessionSandbox,
  SandboxNotReadyError,
  SandboxProvisionFailedError,
  SandboxReleasedError,
  SandboxUnavailableError,
  withSandboxReadinessBarrier,
  type SandboxFactoryContext,
  type SandboxPort,
  type SessionSandbox,
  type SessionSandboxDriver,
  type SessionSandboxRetryPolicy,
} from "../../src/index";
import type { PreparedMarker } from "./in-memory-native-driver";

/*
 * ADR 0014 port-level certification. Every SessionSandboxDriver, wrapped v0
 * adapter or native, runs the same cases through the shared lifecycle. Faults
 * are injected around the driver, so providers need no test hooks.
 */

export interface SessionSandboxCertificationSubject {
  driver: SessionSandboxDriver;
  context: SandboxFactoryContext;
  /** Written by `driver.prepare`; read back through the barrier to prove
   * that ready means prepared. */
  preparedMarker: PreparedMarker;
  /** A command whose output contains `expected` on a prepared sandbox. */
  probe?: { command: string; expected: string };
  cleanup?(): Promise<void>;
}

class Hold {
  readonly #opened: Promise<void>;
  #open!: () => void;

  constructor() {
    this.#opened = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
  }

  open(): void {
    this.#open();
  }

  wait(): Promise<void> {
    return this.#opened;
  }
}

class FaultInjectingDriver implements SessionSandboxDriver {
  readonly provider: string;
  readonly capabilities: SessionSandboxDriver["capabilities"];
  readonly live = new Set<SandboxPort>();
  acquisitions = 0;
  releases = 0;
  #acquireHold: Hold | null = null;
  #prepareHold: Hold | null = null;
  #failAcquires = 0;
  #failPrepares = 0;

  constructor(private readonly inner: SessionSandboxDriver) {
    this.provider = inner.provider;
    this.capabilities = inner.capabilities;
  }

  holdAcquire(): Hold {
    return (this.#acquireHold = new Hold());
  }

  holdPrepare(): Hold {
    return (this.#prepareHold = new Hold());
  }

  failNextAcquires(count: number): void {
    this.#failAcquires = count;
  }

  failNextPrepares(count: number): void {
    this.#failPrepares = count;
  }

  async acquire(input: Parameters<SessionSandboxDriver["acquire"]>[0]): Promise<SandboxPort> {
    this.acquisitions += 1;
    const hold = this.#acquireHold;
    this.#acquireHold = null;
    await hold?.wait();
    if (this.#failAcquires > 0) {
      this.#failAcquires -= 1;
      throw new Error("injected acquire failure");
    }
    // A held acquisition models a provider that cannot be cancelled: it
    // allocates even when the caller has given up.
    const sandbox = await this.inner.acquire({ ...input, signal: new AbortController().signal });
    this.live.add(sandbox);
    return sandbox;
  }

  async prepare(input: Parameters<SessionSandboxDriver["prepare"]>[0]): Promise<void> {
    const hold = this.#prepareHold;
    this.#prepareHold = null;
    await hold?.wait();
    if (this.#failPrepares > 0) {
      this.#failPrepares -= 1;
      throw new Error("injected prepare failure");
    }
    await this.inner.prepare(input);
  }

  async release(input: Parameters<SessionSandboxDriver["release"]>[0]): Promise<void> {
    this.releases += 1;
    this.live.delete(input.sandbox);
    await this.inner.release(input);
  }
}

const FAST_RETRY: SessionSandboxRetryPolicy = { maxAttempts: 2, backoffMs: () => 0 };
const WAIT = { timeoutMs: 10_000 };

export function describeSessionSandboxCertification(
  name: string,
  makeSubject: () => Promise<SessionSandboxCertificationSubject>,
): void {
  describe(`ADR 0014 sandbox port certification: ${name}`, () => {
    let subject: SessionSandboxCertificationSubject;
    let driver: FaultInjectingDriver;
    const opened: SessionSandbox[] = [];
    const open = (retry: SessionSandboxRetryPolicy = FAST_RETRY) => {
      const sandbox = openSessionSandbox(driver, subject.context, { retry });
      opened.push(sandbox);
      return sandbox;
    };
    const probe = () => subject.probe ?? { command: "echo certification-ok", expected: "certification-ok" };

    beforeEach(async () => {
      subject = await makeSubject();
      driver = new FaultInjectingDriver(subject.driver);
    });

    afterEach(async () => {
      await Promise.all(opened.splice(0).map((sandbox) => sandbox.release("deleted")));
      await vi.waitFor(() => expect(driver.live.size).toBe(0));
      await subject.cleanup?.();
    });

    it("declares persistence capabilities instead of probing for them", () => {
      expect(declarePersistenceCapabilities(subject.driver.capabilities))
        .toEqual(subject.driver.capabilities);
      expect(Object.isFrozen(subject.driver.capabilities)).toBe(true);
      expect(open().capabilities).toBe(subject.driver.capabilities);
    });

    it("provision() returns while acquisition is still running", async () => {
      const hold = driver.holdAcquire();
      const sandbox = open();

      sandbox.provision();
      sandbox.provision();

      expect(sandbox.state()).toMatchObject({ phase: "provisioning", step: "acquire" });
      expect(sandbox.current()).toBeNull();
      hold.open();
      const ready = await sandbox.whenReady(WAIT);
      expect(sandbox.current()).toBe(ready);
      expect(driver.acquisitions).toBe(1);
    });

    it("a never-ready sandbox times out the waiter with a tool error and keeps provisioning", async () => {
      const hold = driver.holdAcquire();
      const sandbox = open();

      const error = await sandbox.whenReady({ timeoutMs: 20 }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SandboxNotReadyError);
      expect(error).toBeInstanceOf(SandboxUnavailableError);
      expect((error as SandboxNotReadyError).toolMessage).not.toMatch(/injected|provider/i);
      expect(sandbox.state().phase).toBe("provisioning");
      hold.open();
      await expect(sandbox.whenReady(WAIT)).resolves.toBeTruthy();
      expect(driver.acquisitions).toBe(1);
    });

    it("ready means prepared, not merely acquired", async () => {
      const hold = driver.holdPrepare();
      const sandbox = open();
      sandbox.provision();

      await vi.waitFor(() =>
        expect(sandbox.state()).toMatchObject({ phase: "provisioning", step: "prepare" })
      );
      expect(sandbox.current()).toBeNull();
      await expect(sandbox.whenReady({ timeoutMs: 20 })).rejects.toBeInstanceOf(SandboxNotReadyError);
      hold.open();
      await sandbox.whenReady(WAIT);
      expect(sandbox.state()).toEqual({ phase: "ready" });
      const barrier = withSandboxReadinessBarrier(sandbox, WAIT);
      await expect(barrier.readFile(subject.preparedMarker.path))
        .resolves.toContain(subject.preparedMarker.content);
    });

    it("a sandbox operation during provisioning waits at the barrier, then runs prepared", async () => {
      const hold = driver.holdPrepare();
      const sandbox = open();
      const barrier = withSandboxReadinessBarrier(sandbox, WAIT);
      let settled = false;

      const pending = barrier.exec(probe().command).finally(() => {
        settled = true;
      });
      await vi.waitFor(() =>
        expect(sandbox.state()).toMatchObject({ phase: "provisioning", step: "prepare" })
      );
      expect(settled).toBe(false);
      hold.open();

      await expect(pending).resolves.toContain(probe().expected);
      await expect(barrier.readFile(subject.preparedMarker.path))
        .resolves.toContain(subject.preparedMarker.content);
    });

    it("concurrent waiters share one acquisition", async () => {
      const hold = driver.holdAcquire();
      const sandbox = open();

      const waiters = [sandbox.whenReady(WAIT), sandbox.whenReady(WAIT), sandbox.whenReady(WAIT)];
      sandbox.provision();
      hold.open();
      const ready = await Promise.all(waiters);

      expect(new Set(ready).size).toBe(1);
      expect(driver.acquisitions).toBe(1);
      expect(driver.live.size).toBe(1);
    });

    it("fails after bounded attempts, and the next wait retries", async () => {
      driver.failNextAcquires(2);
      const sandbox = open();

      const error = await sandbox.whenReady(WAIT).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SandboxProvisionFailedError);
      expect((error as SandboxProvisionFailedError).attempts).toBe(2);
      expect((error as SandboxProvisionFailedError).toolMessage).not.toMatch(/injected/);
      expect(sandbox.state()).toMatchObject({ phase: "failed", attempts: 2 });
      await expect(sandbox.whenReady(WAIT)).resolves.toBeTruthy();
      expect(driver.acquisitions).toBe(3);
      expect(driver.live.size).toBe(1);
    });

    it("a failed preparation releases its allocation before retrying", async () => {
      driver.failNextPrepares(1);
      const sandbox = open();

      await sandbox.whenReady(WAIT);

      expect(driver.acquisitions).toBe(2);
      expect(driver.releases).toBe(1);
      expect(driver.live.size).toBe(1);
    });

    it("aborting one waiter does not cancel provisioning", async () => {
      const hold = driver.holdAcquire();
      const sandbox = open();
      const controller = new AbortController();

      const aborted = sandbox.whenReady({ ...WAIT, signal: controller.signal });
      controller.abort(new Error("turn cancelled"));

      await expect(aborted).rejects.toThrow("turn cancelled");
      expect(sandbox.state().phase).toBe("provisioning");
      hold.open();
      await expect(sandbox.whenReady(WAIT)).resolves.toBeTruthy();
      expect(driver.acquisitions).toBe(1);
    });

    it("release during provisioning rejects waiters and cleans up a late allocation", async () => {
      const hold = driver.holdAcquire();
      const sandbox = open();
      const waiter = sandbox.whenReady(WAIT);

      await sandbox.release("deleted");

      await expect(waiter).rejects.toBeInstanceOf(SandboxReleasedError);
      await expect(sandbox.whenReady(WAIT)).rejects.toBeInstanceOf(SandboxReleasedError);
      expect(sandbox.state()).toEqual({ phase: "released", reason: "deleted" });
      hold.open();
      await vi.waitFor(() => expect(driver.releases).toBe(1));
      expect(driver.live.size).toBe(0);
      expect(sandbox.state()).toEqual({ phase: "released", reason: "deleted" });
    });

    it("release after ready frees compute exactly once", async () => {
      const sandbox = open();
      await sandbox.whenReady(WAIT);

      await Promise.all([sandbox.release("archived"), sandbox.release("deleted")]);

      expect(driver.releases).toBe(1);
      expect(driver.live.size).toBe(0);
      expect(sandbox.current()).toBeNull();
      expect(sandbox.state()).toEqual({ phase: "released", reason: "archived" });
      await expect(withSandboxReadinessBarrier(sandbox, WAIT).exec(probe().command))
        .rejects.toBeInstanceOf(SandboxReleasedError);
    });

    it.todo("survives a replica or Durable Object reset during create-time provisioning (rollout step 5)");
    it.todo("recovers after the provider reclaims a ready sandbox (ADR 0005 recovery, rollout step 4)");
  });
}
