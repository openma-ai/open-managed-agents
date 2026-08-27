const PORT_TOKEN = Symbol("open-managed-agents.port-token");

export interface PortToken<Port> {
  readonly name: string;
  readonly __port?: Port;
}

type RuntimePortToken = PortToken<unknown> & {
  readonly [PORT_TOKEN]: true;
};

export interface AppPortBinding<Port = unknown> {
  token: PortToken<Port>;
  value: Port;
}

export interface AppModuleContext {
  port<Port>(token: PortToken<Port>): Port;
}

export interface AppModuleInstance {
  ports: ReadonlyArray<AppPortBinding<unknown>>;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface AppModule {
  name: string;
  provides: readonly PortToken<unknown>[];
  requires?: readonly PortToken<unknown>[];
  setup(context: AppModuleContext): AppModuleInstance;
}

export interface CreateAppOptions {
  modules: readonly AppModule[];
}

export type AppStatus =
  | "created"
  | "starting"
  | "started"
  | "stopping"
  | "stopped"
  | "failed";

export interface App {
  readonly status: AppStatus;
  port<Port>(token: PortToken<Port>): Port;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type AppCompositionErrorCode =
  | "invalid_module"
  | "duplicate_module"
  | "duplicate_port"
  | "missing_port"
  | "undeclared_port_access"
  | "dependency_cycle"
  | "invalid_module_instance";

export class AppCompositionError extends Error {
  constructor(
    readonly code: AppCompositionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppCompositionError";
  }
}

export class AppLifecycleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppLifecycleError";
  }
}

export function createPortToken<Port>(name: string): PortToken<Port> {
  if (name.trim().length === 0) {
    throw new AppCompositionError(
      "invalid_module",
      "Port token name must not be empty",
    );
  }
  return Object.freeze({ name, [PORT_TOKEN]: true }) as PortToken<Port>;
}

export function bindPort<Port>(
  token: PortToken<Port>,
  value: Port,
): AppPortBinding<Port> {
  return { token, value };
}

export interface ProvidePortOptions {
  name?: string;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export function providePort<Port>(
  token: PortToken<Port>,
  value: Port,
  options: ProvidePortOptions = {},
): AppModule {
  assertToken(token);
  return defineAppModule({
    name: options.name ?? `port:${token.name}`,
    provides: [token],
    setup: () => ({
      ports: [bindPort(token, value)],
      ...(options.start ? { start: options.start } : {}),
      ...(options.stop ? { stop: options.stop } : {}),
    }),
  });
}

export function defineAppModule<const Module extends AppModule>(
  module: Module,
): Module {
  return module;
}

function assertToken(token: PortToken<unknown>): asserts token is RuntimePortToken {
  if (
    !token
    || typeof token !== "object"
    || (token as Partial<RuntimePortToken>)[PORT_TOKEN] !== true
  ) {
    throw new AppCompositionError(
      "invalid_module",
      "Modules must use Port tokens created by createPortToken()",
    );
  }
}

function moduleOrder(modules: readonly AppModule[]): AppModule[] {
  const names = new Set<string>();
  const providers = new Map<PortToken<unknown>, AppModule>();
  for (const module of modules) {
    if (module.name.trim().length === 0) {
      throw new AppCompositionError(
        "invalid_module",
        "App module name must not be empty",
      );
    }
    if (names.has(module.name)) {
      throw new AppCompositionError(
        "duplicate_module",
        `Duplicate app module: ${module.name}`,
      );
    }
    names.add(module.name);
    for (const token of module.provides) {
      assertToken(token);
      const previous = providers.get(token);
      if (previous) {
        throw new AppCompositionError(
          "duplicate_port",
          `Port ${token.name} is provided by both ${previous.name} and ${module.name}`,
        );
      }
      providers.set(token, module);
    }
    for (const token of module.requires ?? []) assertToken(token);
  }

  for (const module of modules) {
    for (const token of module.requires ?? []) {
      if (!providers.has(token)) {
        throw new AppCompositionError(
          "missing_port",
          `Module ${module.name} requires missing Port ${token.name}`,
        );
      }
    }
  }

  const ordered: AppModule[] = [];
  const visiting = new Set<AppModule>();
  const visited = new Set<AppModule>();
  const visit = (module: AppModule): void => {
    if (visited.has(module)) return;
    if (visiting.has(module)) {
      throw new AppCompositionError(
        "dependency_cycle",
        `App module dependency cycle includes ${module.name}`,
      );
    }
    visiting.add(module);
    for (const token of module.requires ?? []) {
      const provider = providers.get(token);
      if (provider) visit(provider);
    }
    visiting.delete(module);
    visited.add(module);
    ordered.push(module);
  };
  for (const module of modules) visit(module);
  return ordered;
}

function validateInstance(
  module: AppModule,
  instance: AppModuleInstance,
): void {
  if (!instance || !Array.isArray(instance.ports)) {
    throw new AppCompositionError(
      "invalid_module_instance",
      `Module ${module.name} did not return a ports array`,
    );
  }
  const declared = new Set(module.provides);
  const actual = new Set<PortToken<unknown>>();
  for (const binding of instance.ports) {
    assertToken(binding.token);
    if (!declared.has(binding.token)) {
      throw new AppCompositionError(
        "invalid_module_instance",
        `Module ${module.name} returned undeclared Port ${binding.token.name}`,
      );
    }
    if (actual.has(binding.token)) {
      throw new AppCompositionError(
        "invalid_module_instance",
        `Module ${module.name} returned Port ${binding.token.name} more than once`,
      );
    }
    if (binding.value === undefined) {
      throw new AppCompositionError(
        "invalid_module_instance",
        `Module ${module.name} returned undefined for Port ${binding.token.name}`,
      );
    }
    actual.add(binding.token);
  }
  for (const token of declared) {
    if (!actual.has(token)) {
      throw new AppCompositionError(
        "invalid_module_instance",
        `Module ${module.name} did not return declared Port ${token.name}`,
      );
    }
  }
}

export function createApp(options: CreateAppOptions): App {
  const orderedModules = moduleOrder(options.modules);
  const ports = new Map<PortToken<unknown>, unknown>();
  const instances: AppModuleInstance[] = [];

  for (const module of orderedModules) {
    const allowed = new Set(module.requires ?? []);
    const instance = module.setup({
      port<Port>(token: PortToken<Port>): Port {
        assertToken(token);
        if (!allowed.has(token)) {
          throw new AppCompositionError(
            "undeclared_port_access",
            `Module ${module.name} accessed undeclared Port ${token.name}`,
          );
        }
        return ports.get(token) as Port;
      },
    });
    validateInstance(module, instance);
    for (const binding of instance.ports) {
      ports.set(binding.token, binding.value);
    }
    instances.push(instance);
  }

  let status: AppStatus = "created";
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const started: AppModuleInstance[] = [];

  const app: App = {
    get status() {
      return status;
    },
    port<Port>(token: PortToken<Port>): Port {
      assertToken(token);
      if (!ports.has(token)) {
        throw new AppCompositionError(
          "missing_port",
          `App does not provide Port ${token.name}`,
        );
      }
      return ports.get(token) as Port;
    },
    start(): Promise<void> {
      if (status === "started") return Promise.resolve();
      if (startPromise) return startPromise;
      if (status !== "created") {
        return Promise.reject(new AppLifecycleError(
          `Cannot start app while it is ${status}`,
        ));
      }
      status = "starting";
      startPromise = (async () => {
        try {
          for (const instance of instances) {
            started.push(instance);
            await instance.start?.();
          }
          status = "started";
        } catch (cause) {
          for (const instance of [...started].reverse()) {
            try {
              await instance.stop?.();
            } catch {
              // Preserve the startup failure as the primary cause.
            }
          }
          status = "failed";
          throw new AppLifecycleError("App failed to start", { cause });
        }
      })();
      return startPromise;
    },
    stop(): Promise<void> {
      if (status === "stopped") return Promise.resolve();
      if (stopPromise) return stopPromise;
      if (status === "created") {
        status = "stopped";
        return Promise.resolve();
      }
      if (status !== "started") {
        return Promise.reject(new AppLifecycleError(
          `Cannot stop app while it is ${status}`,
        ));
      }
      status = "stopping";
      stopPromise = (async () => {
        let firstFailure: unknown;
        for (const instance of [...started].reverse()) {
          try {
            await instance.stop?.();
          } catch (cause) {
            firstFailure ??= cause;
          }
        }
        if (firstFailure !== undefined) {
          status = "failed";
          throw new AppLifecycleError("App failed to stop", {
            cause: firstFailure,
          });
        }
        status = "stopped";
      })();
      return stopPromise;
    },
  };
  return app;
}
