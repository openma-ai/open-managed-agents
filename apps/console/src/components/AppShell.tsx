import { useMemo, useState } from "react";
import { Outlet, Navigate, useNavigate } from "react-router";

import {
  Sidebar as ShadcnSidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

import { useAuth } from "../lib/auth";
import { useChordKeybinding, type ChordBinding } from "../lib/useChordKeybinding";
import { ROUTE_CHORDS } from "../lib/route-chords";

import { AppSidebar } from "./AppSidebar";
import { AppBreadcrumb } from "./AppBreadcrumb";
import { BrandLoader } from "./BrandLoader";
import { CommandPalette } from "./CommandPalette";
import { NavigationProgress } from "./NavigationProgress";
import { Logo } from "./Logo";

void ShadcnSidebar;
void SidebarContent;
void SidebarFooter;
void SidebarGroup;
void SidebarGroupContent;
void SidebarGroupLabel;
void SidebarHeader;
void SidebarMenu;
void SidebarMenuButton;
void SidebarMenuItem;

/**
 * AppShell — single-rounded-panel layout, modeled on the benchmark.
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ stage (continuous bg behind everything)                │
 *   │ ┌─────┬────────────────────────────────────────────┐   │
 *   │ │     │ [trigger]  (top toolbar on stage, no chrome)│   │
 *   │ │ side│ ┌──────────────────────────────────────────┐│   │
 *   │ │ bar │ │ pageHeaderSlot  (rounded panel top)      ││   │
 *   │ │     │ ├──────────────────────────────────────────┤│   │
 *   │ │     │ │ main (overflow-y-auto, content scrolls)  ││   │
 *   │ │     │ └──────────────────────────────────────────┘│   │
 *   │ └─────┴────────────────────────────────────────────┘   │
 *   └────────────────────────────────────────────────────────┘
 *
 * The rounded panel only rounds its TOP-LEFT corner (flush against the
 * right + bottom viewport edges). PageHeader uses React portal to render
 * INTO `pageHeaderSlot`, which sits ABOVE the scroll container as a
 * `shrink-0` sibling — so the header literally cannot scroll (no sticky
 * positioning required) and table heads inside `main` can just use
 * `top-0` to pin under the header.
 *
 * Replaces my previous attempt using shadcn `variant="inset"` + nested
 * scroll containers + sticky PageHeader, which broke sticky because
 * shadcn's default `position: fixed` sidebar + nested overflow conflicted.
 */
export interface AppOutletContext {
  pageHeaderSlot: HTMLDivElement | null;
}

export function AppShell() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();
  const [pageHeaderSlot, setPageHeaderSlot] = useState<HTMLDivElement | null>(null);

  // Linear-style chord bindings. Derived from ROUTE_CHORDS so the
  // sidebar / palette / chords stay in lockstep — adding a route to
  // the map enables `g <key>` automatically.
  const chordBindings = useMemo<ChordBinding[]>(
    () =>
      Object.entries(ROUTE_CHORDS).map(([path, key]) => ({
        prefix: "g",
        key,
        handler: () => navigate(path),
        label: path,
      })),
    [navigate],
  );
  useChordKeybinding(chordBindings);

  const outletContext: AppOutletContext = useMemo(
    () => ({ pageHeaderSlot }),
    [pageHeaderSlot],
  );

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <BrandLoader size="lg" label="Loading session" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <TooltipProvider delayDuration={250}>
      <SidebarProvider className="h-svh overflow-hidden">
        <NavigationProgress />
        <CommandPalette />

        {/* Autofill honeypot. Chrome / Safari ignore autoComplete="off"
            on text inputs and aggressively offer saved login credentials
            into the first plausible-looking input. Sit a hidden
            username/password pair at the top of the authenticated DOM
            so the browser fills it instead of any real Title / search /
            whatever input downstream. */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: "-9999px",
            top: "-9999px",
            height: 0,
            width: 0,
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          <input type="text" tabIndex={-1} autoComplete="username" name="username" />
          <input
            type="password"
            tabIndex={-1}
            autoComplete="current-password"
            name="password"
          />
        </div>

        {/* Stage frame — continuous sidebar-tinted bg under everything;
            wraps the whole sidebar + main area so the rounded panel
            inside reads as a card "floating" on the stage. */}
        <div className="flex w-full h-full overflow-hidden bg-sidebar">
          <AppSidebar />

          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            {/* Top toolbar on stage — sits at the SAME h-11 baseline as
                the sidebar brand row so the logo, openma text,
                SidebarTrigger and breadcrumb all share one horizontal
                axis. Never scrolls; lives outside the rounded panel so
                the panel's top corner can round cleanly. */}
            <header className="h-11 shrink-0 flex items-center gap-2 px-2 bg-sidebar text-sm text-fg-muted">
              <SidebarTrigger className="h-7 w-7 text-fg-muted hover:text-fg" />
              <div className="flex items-center gap-1.5 md:hidden">
                <Logo size="sm" className="!h-6 !w-6" />
                <span className="font-mono font-bold text-sm text-brand">openma</span>
              </div>
              <AppBreadcrumb />
            </header>

            {/* Rounded panel — top-left rounded only so it visually fuses
                with the sidebar on its left and the viewport edge on the
                right/bottom. Hosts the per-page header slot (sticky by
                construction) + scrollable main. */}
            <div className="flex-1 min-h-0 rounded-tl-lg border-t border-l border-border bg-bg flex flex-col overflow-hidden">
              <div
                ref={setPageHeaderSlot}
                className="empty:hidden shrink-0 border-b border-border"
              />
              <main className="flex-1 min-h-0 overflow-y-auto bg-bg">
                <Outlet context={outletContext} />
              </main>
            </div>
          </div>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}
