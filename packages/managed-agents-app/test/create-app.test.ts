import { describe, expect, it } from "vitest";

import {
  AppCompositionError,
  createApp,
  createPortToken,
  defineAppModule,
  providePort,
} from "../src/index";

describe("createApp composition kernel", () => {
  it("turns a platform adapter into an explicit singleton Port module", async () => {
    const calls: string[] = [];
    const clockPort = createPortToken<{ now(): number }>("clock");
    const clock = { now: () => 42 };
    const app = createApp({
      modules: [providePort(clockPort, clock, {
        start: () => { calls.push("start"); },
        stop: () => { calls.push("stop"); },
      })],
    });

    expect(app.port(clockPort)).toBe(clock);
    await app.start();
    await app.stop();
    expect(calls).toEqual(["start", "stop"]);
  });

  it("assembles an out-of-order Port DAG and owns deterministic lifecycle", async () => {
    const calls: string[] = [];
    const loggerPort = createPortToken<{ log(message: string): void }>("logger");
    const recordsPort = createPortToken<{ count(): number }>("records");
    const servicePort = createPortToken<{ summarize(): string }>("service");

    const serviceModule = defineAppModule({
      name: "service",
      provides: [servicePort],
      requires: [recordsPort],
      setup({ port }) {
        const records = port(recordsPort);
        return {
          ports: [{
            token: servicePort,
            value: { summarize: () => `${records.count()} records` },
          }],
          start: () => { calls.push("start:service"); },
          stop: () => { calls.push("stop:service"); },
        };
      },
    });
    const recordsModule = defineAppModule({
      name: "records",
      provides: [recordsPort],
      requires: [loggerPort],
      setup({ port }) {
        const logger = port(loggerPort);
        logger.log("setup:records");
        return {
          ports: [{ token: recordsPort, value: { count: () => 3 } }],
          start: () => { calls.push("start:records"); },
          stop: () => { calls.push("stop:records"); },
        };
      },
    });
    const loggerModule = defineAppModule({
      name: "logger",
      provides: [loggerPort],
      setup() {
        return {
          ports: [{
            token: loggerPort,
            value: { log: (message: string) => { calls.push(message); } },
          }],
          start: () => { calls.push("start:logger"); },
          stop: () => { calls.push("stop:logger"); },
        };
      },
    });

    const app = createApp({
      modules: [serviceModule, recordsModule, loggerModule],
    });

    expect(app.status).toBe("created");
    expect(app.port(servicePort).summarize()).toBe("3 records");
    expect(calls).toEqual(["setup:records"]);

    await app.start();
    expect(app.status).toBe("started");
    expect(calls).toEqual([
      "setup:records",
      "start:logger",
      "start:records",
      "start:service",
    ]);

    await app.stop();
    expect(app.status).toBe("stopped");
    expect(calls).toEqual([
      "setup:records",
      "start:logger",
      "start:records",
      "start:service",
      "stop:service",
      "stop:records",
      "stop:logger",
    ]);
  });

  it("rejects a declared Port whose module binds no usable value", () => {
    const storagePort = createPortToken<{ read(): string }>("storage");

    expect(() => createApp({
      modules: [defineAppModule({
        name: "broken-storage",
        provides: [storagePort],
        setup: () => ({
          ports: [{ token: storagePort, value: undefined }],
        }),
      })],
    })).toThrowError(expect.objectContaining({
      name: "AppCompositionError",
      code: "invalid_module_instance",
    }));
  });

  it("fails fast on missing, duplicate, cyclic, and undeclared Port wiring", () => {
    const aPort = createPortToken<{ a(): void }>("a");
    const bPort = createPortToken<{ b(): void }>("b");

    expect(() => createApp({
      modules: [defineAppModule({
        name: "missing-consumer",
        provides: [aPort],
        requires: [bPort],
        setup: () => ({ ports: [{ token: aPort, value: { a() {} } }] }),
      })],
    })).toThrowError(expect.objectContaining({ code: "missing_port" }));

    expect(() => createApp({
      modules: [
        defineAppModule({
          name: "a-one",
          provides: [aPort],
          setup: () => ({ ports: [{ token: aPort, value: { a() {} } }] }),
        }),
        defineAppModule({
          name: "a-two",
          provides: [aPort],
          setup: () => ({ ports: [{ token: aPort, value: { a() {} } }] }),
        }),
      ],
    })).toThrowError(expect.objectContaining({ code: "duplicate_port" }));

    expect(() => createApp({
      modules: [
        defineAppModule({
          name: "cyclic-a",
          provides: [aPort],
          requires: [bPort],
          setup: () => ({ ports: [{ token: aPort, value: { a() {} } }] }),
        }),
        defineAppModule({
          name: "cyclic-b",
          provides: [bPort],
          requires: [aPort],
          setup: () => ({ ports: [{ token: bPort, value: { b() {} } }] }),
        }),
      ],
    })).toThrowError(expect.objectContaining({ code: "dependency_cycle" }));

    expect(() => createApp({
      modules: [
        defineAppModule({
          name: "a-provider",
          provides: [aPort],
          setup: () => ({ ports: [{ token: aPort, value: { a() {} } }] }),
        }),
        defineAppModule({
          name: "undeclared-consumer",
          provides: [bPort],
          setup: ({ port }) => {
            port(aPort);
            return { ports: [{ token: bPort, value: { b() {} } }] };
          },
        }),
      ],
    })).toThrowError(expect.objectContaining({ code: "undeclared_port_access" }));

    expect(AppCompositionError.prototype).toBeInstanceOf(Error);
  });

  it("rolls back the failing module and prior modules when startup fails", async () => {
    const calls: string[] = [];
    const aPort = createPortToken<object>("rollback-a");
    const bPort = createPortToken<object>("rollback-b");
    const app = createApp({
      modules: [
        defineAppModule({
          name: "rollback-a",
          provides: [aPort],
          setup: () => ({
            ports: [{ token: aPort, value: {} }],
            start: () => { calls.push("start:a"); },
            stop: () => { calls.push("stop:a"); },
          }),
        }),
        defineAppModule({
          name: "rollback-b",
          provides: [bPort],
          requires: [aPort],
          setup: () => ({
            ports: [{ token: bPort, value: {} }],
            start: () => {
              calls.push("start:b");
              throw new Error("cannot start b");
            },
            stop: () => { calls.push("stop:b"); },
          }),
        }),
      ],
    });

    await expect(app.start()).rejects.toThrow("App failed to start");
    expect(app.status).toBe("failed");
    expect(calls).toEqual(["start:a", "start:b", "stop:b", "stop:a"]);
  });
});
