import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  Navigate,
  RouterProvider,
  createBrowserRouter,
  type RouteObject,
} from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
// Bundled font (woff2 shipped with the app) so Logo's `[ ]` brackets render
// in JetBrains Mono on first paint — Google Fonts `display=swap` would
// otherwise render the brackets in SF Mono first, then re-render in
// JetBrains Mono when the network fetch resolves, producing a visible
// width shift in the sidebar header.
import "@fontsource-variable/jetbrains-mono";
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
  // Nested route groups so detail pages publish a proper hierarchy
  // through `useMatches()` — `/agents/:id` resolves to
  // [agents-parent, agents/:id], so AppBreadcrumb renders
  // `Agents › Agent` instead of just `Agent` with no link back.
  {
    path: "agents",
    handle: { crumb: "Agents" },
    children: [
      { index: true, element: <AgentsList /> },
      { path: ":id", element: <AgentDetail />, handle: { crumb: "Agent" } },
    ],
  },
  {
    path: "sessions",
    handle: { crumb: "Sessions" },
    children: [
      { index: true, element: <SessionsList /> },
      {
        path: ":id",
        handle: { crumb: "Session" },
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
  { path: "files", element: <FilesList />, handle: { crumb: "Files" } },
  {
    path: "evals",
    handle: { crumb: "Eval Runs" },
    children: [
      { index: true, element: <EvalRunsList /> },
      { path: ":id", element: <EvalRunDetail />, handle: { crumb: "Eval Run" } },
    ],
  },
  {
    path: "environments",
    handle: { crumb: "Environments" },
    children: [
      { index: true, element: <EnvironmentsList /> },
      {
        path: ":id",
        element: <EnvironmentDetail />,
        handle: { crumb: "Environment" },
      },
    ],
  },
  { path: "skills", element: <SkillsList />, handle: { crumb: "Skills" } },
  { path: "vaults", element: <VaultsList />, handle: { crumb: "Credential Vaults" } },
  {
    path: "memory",
    handle: { crumb: "Memory Stores" },
    children: [
      { index: true, element: <MemoryStoresList /> },
      {
        path: ":id",
        element: <MemoryStoreDetail />,
        handle: { crumb: "Memory Store" },
      },
    ],
  },
  { path: "model-cards", element: <ModelCardsList />, handle: { crumb: "Model Cards" } },
  { path: "api-keys", element: <ApiKeysList />, handle: { crumb: "API Keys" } },
  { path: "runtimes", element: <RuntimesList />, handle: { crumb: "Local Runtimes" } },
  {
    path: "integrations",
    handle: { crumb: "Integrations" },
    children: [
      {
        path: "linear",
        handle: { crumb: "Linear" },
        children: [
          { index: true, element: <IntegrationsLinearList /> },
          {
            path: "publish",
            element: <IntegrationsLinearPublishPage />,
            handle: { crumb: "Publish" },
          },
          {
            path: "install-pat",
            element: <IntegrationsLinearPatInstallPage />,
            handle: { crumb: "Install PAT" },
          },
          {
            path: "installations/:id",
            element: <IntegrationsLinearWorkspace />,
            handle: { crumb: "Workspace" },
          },
        ],
      },
      {
        path: "github",
        handle: { crumb: "GitHub" },
        children: [
          { index: true, element: <IntegrationsGitHubList /> },
          {
            path: "bind",
            element: <IntegrationsGitHubBindPage />,
            handle: { crumb: "Bind" },
          },
          {
            path: "installations/:id",
            element: <IntegrationsGitHubWorkspace />,
            handle: { crumb: "Workspace" },
          },
        ],
      },
      {
        path: "slack",
        handle: { crumb: "Slack" },
        children: [
          { index: true, element: <IntegrationsSlackList /> },
          {
            path: "publish",
            element: <IntegrationsSlackPublishPage />,
            handle: { crumb: "Publish" },
          },
          {
            path: "installations/:id",
            element: <IntegrationsSlackWorkspace />,
            handle: { crumb: "Workspace" },
          },
        ],
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
