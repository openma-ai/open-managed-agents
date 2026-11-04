import { describe, expect, it, vi } from "vitest";
import { matchRoutes, type RouteObject } from "react-router";

const observed = vi.hoisted(() => ({ dashboardLoaded: false, routes: [] as RouteObject[] }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: vi.fn() }) }));
vi.mock("react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-router")>(),
  createBrowserRouter: (routes: RouteObject[]) => { observed.routes = routes; return {}; },
}));
vi.mock("./pages/Dashboard", () => {
  observed.dashboardLoaded = true;
  return { Dashboard: () => null };
});
vi.mock("./lib/branding", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lib/branding")>(), loadBranding: vi.fn(),
}));

describe("Console route loading", () => {
  it("does not evaluate Dashboard when bootstrapping the login route", async () => {
    await import("./main");
    expect(observed.dashboardLoaded).toBe(false);
    const login = matchRoutes(observed.routes, "/login")!.at(-1)!.route;
    expect(login.element).toBeDefined();
    const dashboard = matchRoutes(observed.routes, "/")!.at(-1)!.route;
    expect(typeof dashboard.lazy).toBe("function");
    const loaded = await (dashboard.lazy as () => Promise<{ Component: unknown }>)();
    expect(loaded.Component).toBeTypeOf("function");
    expect(observed.dashboardLoaded).toBe(true);
  });

  it("retains detail params, breadcrumb parents, aliases and the unknown-route fallback", () => {
    for (const group of ["agents", "sessions", "deployments", "environments", "vaults", "memory", "evals", "loops", "bonds"]) {
      const matches = matchRoutes(observed.routes, `/${group}/audit-id`)!;
      expect(matches.at(-1)!.params.id).toBe("audit-id");
      expect(matches.some(({ route }) => route.handle?.crumb)).toBe(true);
      expect(typeof matches.at(-1)!.route.lazy).toBe("function");
    }
    const newDeployment = matchRoutes(observed.routes, "/deployments/new")!;
    expect(newDeployment.at(-1)!.route.path).toBe("new");
    expect(newDeployment.map(({ route }) => route.handle?.crumb)).toEqual(
      expect.arrayContaining(["Deployments", "New"]),
    );
    expect(matchRoutes(observed.routes, "/integrations/feishu/old")!.at(-1)!.route.path).toBe("feishu/*");
    expect(matchRoutes(observed.routes, "/unknown-path")!.at(-1)!.route.path).toBe("*");
  });

  it("provides a recovery boundary and initial loading feedback for lazy routes", () => {
    const shell = matchRoutes(observed.routes, "/environments")![0].route;
    expect(shell.ErrorBoundary ?? shell.errorElement).toBeDefined();
    expect(shell.HydrateFallback ?? shell.hydrateFallbackElement).toBeDefined();
  });
});
