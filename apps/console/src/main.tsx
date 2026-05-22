import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  Navigate,
  RouterProvider,
  createBrowserRouter,
  type RouteObject,
} from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { AuthProvider } from "./lib/auth";
import { Toaster } from "./components/ui/sonner";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { queryClient } from "./lib/query-client";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { AgentsList } from "./pages/AgentsList";
import { AgentDetail } from "./pages/AgentDetail";
import { SessionsList } from "./pages/SessionsList";
import { FilesList } from "./pages/FilesList";
import { EnvironmentsList } from "./pages/EnvironmentsList";
import { EnvironmentDetail } from "./pages/EnvironmentDetail";
import { VaultsList } from "./pages/VaultsList";
import { SkillsList } from "./pages/SkillsList";
import { MemoryStoresList } from "./pages/MemoryStoresList";
import { MemoryStoreDetail } from "./pages/MemoryStoreDetail";
import { ModelCardsList } from "./pages/ModelCardsList";
import { ApiKeysList } from "./pages/ApiKeysList";
import { CliLogin } from "./pages/CliLogin";
import { RuntimesList } from "./pages/RuntimesList";
import { ConnectRuntime } from "./pages/ConnectRuntime";
import { EvalRunsList } from "./pages/EvalRunsList";
import { EvalRunDetail } from "./pages/EvalRunDetail";
import {
  IntegrationsLinearList,
  IntegrationsLinearWorkspace,
  IntegrationsLinearPublishPage,
  IntegrationsLinearPatInstallPage,
} from "./pages/IntegrationsLinear";
import {
  IntegrationsGitHubList,
  IntegrationsGitHubWorkspace,
  IntegrationsGitHubBindPage,
} from "./pages/IntegrationsGitHub";
import {
  IntegrationsSlackList,
  IntegrationsSlackWorkspace,
  IntegrationsSlackPublishPage,
} from "./pages/IntegrationsSlack";
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
  { index: true, element: <Dashboard />, handle: { crumb: "Dashboard" } },
  { path: "agents", element: <AgentsList />, handle: { crumb: "Agents" } },
  { path: "agents/:id", element: <AgentDetail />, handle: { crumb: "Agent" } },
  { path: "sessions", element: <SessionsList />, handle: { crumb: "Sessions" } },
  {
    path: "sessions/:id",
    handle: { crumb: "Session" },
    // SessionDetail lazy-loads — it pulls in ai-elements + Shiki +
    // Streamdown + mermaid + dozens of language defs (~500 kB gzipped).
    // Splitting it out keeps the initial bundle for /agents, /sessions
    // list, etc. under 350 kB.
    lazy: async () => {
      const { SessionDetail } = await import("./pages/SessionDetail");
      return { Component: SessionDetail };
    },
  },
  { path: "files", element: <FilesList />, handle: { crumb: "Files" } },
  { path: "evals", element: <EvalRunsList />, handle: { crumb: "Eval Runs" } },
  { path: "evals/:id", element: <EvalRunDetail />, handle: { crumb: "Eval Run" } },
  { path: "environments", element: <EnvironmentsList />, handle: { crumb: "Environments" } },
  { path: "environments/:id", element: <EnvironmentDetail />, handle: { crumb: "Environment" } },
  { path: "skills", element: <SkillsList />, handle: { crumb: "Skills" } },
  { path: "vaults", element: <VaultsList />, handle: { crumb: "Credential Vaults" } },
  { path: "memory", element: <MemoryStoresList />, handle: { crumb: "Memory Stores" } },
  { path: "memory/:id", element: <MemoryStoreDetail />, handle: { crumb: "Memory Store" } },
  { path: "model-cards", element: <ModelCardsList />, handle: { crumb: "Model Cards" } },
  { path: "api-keys", element: <ApiKeysList />, handle: { crumb: "API Keys" } },
  { path: "runtimes", element: <RuntimesList />, handle: { crumb: "Local Runtimes" } },
  {
    path: "integrations/linear",
    element: <IntegrationsLinearList />,
    handle: { crumb: "Linear" },
  },
  {
    path: "integrations/linear/publish",
    element: <IntegrationsLinearPublishPage />,
    handle: { crumb: "Publish" },
  },
  {
    path: "integrations/linear/install-pat",
    element: <IntegrationsLinearPatInstallPage />,
    handle: { crumb: "Install PAT" },
  },
  {
    path: "integrations/linear/installations/:id",
    element: <IntegrationsLinearWorkspace />,
    handle: { crumb: "Workspace" },
  },
  {
    path: "integrations/github",
    element: <IntegrationsGitHubList />,
    handle: { crumb: "GitHub" },
  },
  {
    path: "integrations/github/bind",
    element: <IntegrationsGitHubBindPage />,
    handle: { crumb: "Bind" },
  },
  {
    path: "integrations/github/installations/:id",
    element: <IntegrationsGitHubWorkspace />,
    handle: { crumb: "Workspace" },
  },
  {
    path: "integrations/slack",
    element: <IntegrationsSlackList />,
    handle: { crumb: "Slack" },
  },
  {
    path: "integrations/slack/publish",
    element: <IntegrationsSlackPublishPage />,
    handle: { crumb: "Publish" },
  },
  {
    path: "integrations/slack/installations/:id",
    element: <IntegrationsSlackWorkspace />,
    handle: { crumb: "Workspace" },
  },
  // Plugin-contributed routes (hosted-only extensions). Default empty in
  // OSS — hosted deploy overlays plugins/registry.ts to inject billing
  // / etc. PluginRoute keeps the same `{ path, element }` shape that
  // RouteObject expects.
  ...consolePlugins.flatMap((p) => p.routes ?? []),
  { path: "*", element: <Navigate to="/agents" replace /> },
];

const router = createBrowserRouter([
  { path: "login", element: <Login /> },
  { path: "cli/login", element: <CliLogin /> },
  { path: "connect-runtime", element: <ConnectRuntime /> },
  {
    element: <AppShell />,
    children: protectedRoutes,
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Suspense fallback={null}>
            <RouterProvider router={router} />
          </Suspense>
        </AuthProvider>
        <Toaster />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
