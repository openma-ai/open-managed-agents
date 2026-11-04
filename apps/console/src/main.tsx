import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  Navigate,
  RouterProvider,
  createBrowserRouter,
  type RouteObject,
  type UIMatch,
} from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
// Bundled font (woff2 shipped with the app) so Logo's `[ ]` brackets render
// in JetBrains Mono on first paint — Google Fonts `display=swap` would
// otherwise render the brackets in SF Mono first, then re-render in
// JetBrains Mono when the network fetch resolves, producing a visible
// width shift in the sidebar header.
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/geist";
import "./index.css";
import { AuthProvider } from "./lib/auth";
import { I18nProvider } from "./i18n";
import { Toaster } from "./components/ui/sonner";
import { OpenmaStartupLoader } from "./components/OpenmaStartupLoader";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { queryClient } from "./lib/query-client";
import { loadBranding } from "./lib/branding";
import { Login } from "./pages/Login";
import { RouteLoadError, RouteLoading } from "./components/RouteLoading";
import { consolePlugins } from "./plugins/registry";

/**
 * Router config. Migrated from declarative `<BrowserRouter><Routes>` to
 * the data router (`createBrowserRouter` + `<RouterProvider>`) so we
 * can use `useMatches()` / per-route `handle` / loaders / actions.
 * Hooks that throw "must be used within a data router" — AppBreadcrumb,
 * future loader-driven pages — now work.
 *
 * Lazy chunks use the data-router-native `lazy:` field, which returns
 * an object with `Component` (and optionally `loader`, `action`,
 * `errorElement` etc). Compared to wrapping `<React.lazy />` in a
 * `<Suspense>`, the data router knows to await the chunk before
 * rendering the route, avoiding a flash of fallback during navigation.
 *
 * Per-route `handle.crumb` publishes a label for AppBreadcrumb. For
 * fixed labels pass a string; for dynamic labels (resource name from
 * the loader) pass a function that reads the match.
 */

const protectedRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import("./pages/Dashboard")).Dashboard }), handle: { crumb: "Dashboard" } },
  // Nested route groups so detail pages publish a proper hierarchy
  // through `useMatches()` — `/agents/:id` resolves to
  // [agents-parent, agents/:id], so AppBreadcrumb renders
  // `Agents › Agent` instead of just `Agent` with no link back.
  {
    path: "agents",
    handle: { crumb: "Agents" },
    children: [
      { index: true, lazy: async () => ({ Component: (await import("./pages/AgentsList")).AgentsList }) },
      {
        path: ":id",
        lazy: async () => ({ Component: (await import("./pages/AgentDetail")).AgentDetail }),
        handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Agent" },
      },
    ],
  },
  {
    path: "sessions",
    handle: { crumb: "Sessions" },
    children: [
      { index: true, lazy: async () => ({ Component: (await import("./pages/SessionsList")).SessionsList }) },
      {
        path: ":id",
        handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Session" },
        // SessionDetail lazy-loads — it pulls in ai-elements + Shiki +
        // Streamdown + mermaid + dozens of language defs (~500 kB
        // gzipped). Splitting it out keeps the initial bundle for
        // /agents, /sessions list, etc. under 350 kB.
        lazy: async () => {
          const { SessionDetail } = await import("./pages/SessionDetail");
          return { Component: SessionDetail };
        },
      },
    ],
  },
  {
    path: "deployments",
    handle: { crumb: "Deployments" },
    children: [
      { index: true, lazy: async () => ({ Component: (await import("./pages/DeploymentsList")).DeploymentsList }) },
      { path: "new", lazy: async () => ({ Component: (await import("./pages/DeploymentNew")).DeploymentNew }), handle: { crumb: "New" } },
      {
        path: ":id",
        lazy: async () => ({ Component: (await import("./pages/DeploymentDetail")).DeploymentDetail }),
        handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Deployment" },
      },
    ],
  },
  { path: "files", lazy: async () => ({ Component: (await import("./pages/FilesList")).FilesList }), handle: { crumb: "Files" } },
  {
    path: "evals",
    handle: { crumb: "Eval Runs" },
    children: [
      { index: true, lazy: async () => ({ Component: (await import("./pages/EvalRunsList")).EvalRunsList }) },
      {
        path: ":id",
        lazy: async () => ({ Component: (await import("./pages/EvalRunDetail")).EvalRunDetail }),
        handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Eval Run" },
      },
    ],
  },
  {
    path: "environments",
    handle: { crumb: "Environments" },
    children: [
      { index: true, lazy: async () => ({ Component: (await import("./pages/EnvironmentsList")).EnvironmentsList }) },
      {
        path: ":id",
        lazy: async () => ({ Component: (await import("./pages/EnvironmentDetail")).EnvironmentDetail }),
        handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Environment" },
      },
    ],
  },
  { path: "skills", lazy: async () => ({ Component: (await import("./pages/SkillsList")).SkillsList }), handle: { crumb: "Skills" } },
  {
    path: "vaults",
    handle: { crumb: "Credential Vaults" },
    children: [
      { index: true, lazy: async () => ({ Component: (await import("./pages/VaultsList")).VaultsList }) },
      {
        path: ":id",
        lazy: async () => ({ Component: (await import("./pages/VaultDetail")).VaultDetail }),
        handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Vault" },
      },
    ],
  },
  {
    path: "memory",
    handle: { crumb: "Memory Stores" },
    children: [
      { index: true, lazy: async () => ({ Component: (await import("./pages/MemoryStoresList")).MemoryStoresList }) },
      {
        path: ":id",
        lazy: async () => ({ Component: (await import("./pages/MemoryStoreDetail")).MemoryStoreDetail }),
        handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Memory Store" },
      },
    ],
  },
  { path: "model-cards", lazy: async () => ({ Component: (await import("./pages/ModelCardsList")).ModelCardsList }), handle: { crumb: "Model Cards" } },
  { path: "budget", lazy: async () => ({ Component: (await import("./pages/Budget")).Budget }), handle: { crumb: "Budget" } },
  { path: "members", lazy: async () => ({ Component: (await import("./pages/WorkspaceMembers")).WorkspaceMembers }), handle: { crumb: "Members" } },
  { path: "api-keys", lazy: async () => ({ Component: (await import("./pages/ApiKeysList")).ApiKeysList }), handle: { crumb: "API Keys" } },
  { path: "runtimes", lazy: async () => ({ Component: (await import("./pages/RuntimesList")).RuntimesList }), handle: { crumb: "Local Runtimes" } },
  {
    path: "loops",
    handle: { crumb: "Loops" },
    children: [
      { index: true, lazy: async () => ({ Component: (await import("./pages/Loops")).LoopsPage }) },
      { path: "new", lazy: async () => ({ Component: (await import("./pages/Loops")).LoopEditPage }), handle: { crumb: "New" } },
      { path: "templates", lazy: async () => ({ Component: (await import("./pages/Loops")).LoopTemplatesPage }), handle: { crumb: "Templates" } },
      { path: ":id", lazy: async () => ({ Component: (await import("./pages/Loops")).LoopEditPage }), handle: { crumb: "Loop" } },
    ],
  },
  {
    path: "bonds",
    handle: { crumb: "Bonds" },
    children: [
      { index: true, lazy: async () => ({ Component: (await import("./pages/Bonds")).BondsPage }) },
      { path: "new", lazy: async () => ({ Component: (await import("./pages/Bonds")).BondLinkPage }), handle: { crumb: "New" } },
      {
        path: ":id",
        lazy: async () => ({ Component: (await import("./pages/Bonds")).BondDetailPage }),
        handle: {
          crumb: (m: UIMatch) => {
            const id = (m.params.id as string | undefined) ?? "Bond";
            return id.slice(id.indexOf(":") + 1);
          },
        },
      },
    ],
  },
  {
    path: "integrations",
    handle: { crumb: "Integrations" },
    children: [
      {
        path: "linear",
        handle: { crumb: "Linear" },
        children: [
          { index: true, lazy: async () => ({ Component: (await import("./pages/IntegrationsLinear")).IntegrationsLinearList }) },
          {
            path: "publish",
            lazy: async () => ({ Component: (await import("./pages/IntegrationsLinear")).IntegrationsLinearPublishPage }),
            handle: { crumb: "Publish" },
          },
          {
            path: "install-pat",
            lazy: async () => ({ Component: (await import("./pages/IntegrationsLinear")).IntegrationsLinearPatInstallPage }),
            handle: { crumb: "Install PAT" },
          },
          {
            path: "installations/:id",
            lazy: async () => ({ Component: (await import("./pages/IntegrationsLinear")).IntegrationsLinearWorkspace }),
            handle: { crumb: "Workspace" },
          },
        ],
      },
      {
        path: "github",
        handle: { crumb: "GitHub" },
        children: [
          { index: true, lazy: async () => ({ Component: (await import("./pages/IntegrationsGitHub")).IntegrationsGitHubList }) },
          {
            path: "bind",
            lazy: async () => ({ Component: (await import("./pages/IntegrationsGitHub")).IntegrationsGitHubBindPage }),
            handle: { crumb: "Bind" },
          },
          {
            path: "installations/:id",
            lazy: async () => ({ Component: (await import("./pages/IntegrationsGitHub")).IntegrationsGitHubWorkspace }),
            handle: { crumb: "Workspace" },
          },
        ],
      },
      {
        path: "slack",
        handle: { crumb: "Slack" },
        children: [
          { index: true, lazy: async () => ({ Component: (await import("./pages/IntegrationsSlack")).IntegrationsSlackList }) },
          {
            path: "publish",
            lazy: async () => ({ Component: (await import("./pages/IntegrationsSlack")).IntegrationsSlackPublishPage }),
            handle: { crumb: "Publish" },
          },
          {
            path: "installations/:id",
            lazy: async () => ({ Component: (await import("./pages/IntegrationsSlack")).IntegrationsSlackWorkspace }),
            handle: { crumb: "Workspace" },
          },
        ],
      },
      {
        // Feishu now lives under Loops: link the app from a Loop's Bond field.
        path: "feishu/*",
        element: <Navigate to="/loops?template=feishu-agent" replace />,
      },
    ],
  },
  // Plugin-contributed routes (hosted-only extensions). Default empty in
  // OSS — hosted deploy overlays plugins/registry.ts to inject billing
  // / etc. PluginRoute keeps the same `{ path, element }` shape that
  // RouteObject expects.
  ...consolePlugins.flatMap((p) => p.routes ?? []),
  { path: "*", element: <Navigate to="/agents" replace /> },
];

const router = createBrowserRouter([
  { path: "join", lazy: async () => ({ Component: (await import("./pages/WorkspaceMembers")).JoinWorkspace }), ErrorBoundary: RouteLoadError, HydrateFallback: RouteLoading },
  { path: "login", element: <Login /> },
  { path: "cli/login", lazy: async () => ({ Component: (await import("./pages/CliLogin")).CliLogin }), ErrorBoundary: RouteLoadError, HydrateFallback: RouteLoading },
  { path: "connect-runtime", lazy: async () => ({ Component: (await import("./pages/ConnectRuntime")).ConnectRuntime }), ErrorBoundary: RouteLoadError, HydrateFallback: RouteLoading },
  {
    lazy: async () => ({ Component: (await import("./components/AppShell")).AppShell }),
    children: protectedRoutes,
    ErrorBoundary: RouteLoadError,
    HydrateFallback: RouteLoading,
  },
]);

void loadBranding();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
          <Suspense fallback={<div className="flex h-screen items-center justify-center bg-bg"><OpenmaStartupLoader /></div>}>
              <RouterProvider router={router} />
            </Suspense>
          </AuthProvider>
          <Toaster />
        </QueryClientProvider>
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
