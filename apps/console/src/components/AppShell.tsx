import { useMemo, useRef, useState } from "react";
import { Outlet, Navigate, useLocation, useNavigate } from "react-router";

import {
  Sidebar,
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

void SidebarContent;
void SidebarFooter;
void SidebarGroup;
void SidebarGroupContent;
void SidebarGroupLabel;
void SidebarHeader;
void SidebarMenu;
void SidebarMenuButton;
void SidebarMenuItem;

import { AppSidebar } from "./AppSidebar";
import { AppBreadcrumb } from "./AppBreadcrumb";
import { BrandLoader } from "./BrandLoader";
import { CommandPalette } from "./CommandPalette";
import { NavigationProgress } from "./NavigationProgress";
import { Logo } from "./Logo";

/**
 * AppShell — sidebar + main outlet.
 *
 *   ┌─sidebar──┬───────────────────────────┐
 *   │ brand    │ trigger + breadcrumb      │
 *   │ nav      ├───────────────────────────┤
 *   │ ...      │ rounded-tl panel          │
 *   │ user     │  pageHeaderSlot           │
 *   │          │  <Outlet> (scrolls)       │
 *   └──────────┴───────────────────────────┘
 *
 * Structurally cloned from minimaxhub_benchmark/AppShell so the
 * sidebar/stage seam, sticky behavior, and dimensions match a known-
 * good layout instead of repeatedly inventing variants:
 *   - Outer flex container is `bg-sidebar h-full overflow-hidden` —
 *     the "stage" tint runs continuously behind sidebar + main header,
 *     so the rounded white panel reads as a card floating on it.
 *   - `<Sidebar className="bg-sidebar border-0 group-data-[side=left]:
 *     border-r-0">` — explicit border kill, otherwise shadcn's default
 *     `group-data-[side=left]:border-r` leaves a hairline at the seam
 *     that anti-aliases into a visible dark line against the rounded
 *     corner next door.
 *   - Top header is `h-11 bg-sidebar shrink-0` — same baseline as the
 *     sidebar brand row so `[ logo openma ]` and `[ trigger / crumb ]`
 *     align horizontally on one shared 44-px band.
 *   - PageHeader is portaled into a `shrink-0` slot that sits ABOVE
 *     `<main>` (the scroll context) — slot literally cannot scroll,
 *     so the per-page header is "sticky" by construction, no CSS
 *     positioning involved.
 */
export interface AppOutletContext {
  pageHeaderSlot: HTMLDivElement | null;
}

export function AppShell() {
  const { isAuthenticated, isLoading } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [pageHeaderSlot, setPageHeaderSlot] = useState<HTMLDivElement | null>(null);

  // Linear-style chord bindings.
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

  // Scroll-shadow: hide the divider under PageHeader when at top,
  // show it once user has scrolled the panel content. `<main>`
  // remounts on route change so the listener gets re-bound there.
  const mainRef = useRef<HTMLElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  useMemo(() => {
    // re-binding handled by `key={pathname}` on <main> + a ref callback.
    void pathname;
  }, [pathname]);

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
      <SidebarProvider
        className="h-svh overflow-hidden"
        style={{
          // 224px expanded, 52px collapsed-icon — matches benchmark.
          "--sidebar-width": "14rem",
          "--sidebar-width-icon": "3.25rem",
        } as React.CSSProperties}
      >
        <NavigationProgress />
        <CommandPalette />

        {/* Autofill honeypot — Chrome/Safari ignore autoComplete="off"
            and fill the first plausible input. Sit a hidden username/
            password pair at the top of the authenticated DOM so the
            browser fills it instead of any real input below. */}
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

        <div className="flex w-full bg-sidebar h-full overflow-hidden">
          <AppSidebar />

          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <header className="h-11 flex items-center gap-1.5 pl-2 pr-4 bg-sidebar shrink-0">
              <SidebarTrigger className="h-6 w-6 text-fg-muted hover:text-fg hover:bg-sidebar-accent" />
              <AppBreadcrumb />
            </header>

            <div className="flex-1 min-h-0 rounded-tl-lg bg-bg flex flex-col overflow-hidden">
              <div
                ref={setPageHeaderSlot}
                className={[
                  "empty:hidden shrink-0 transition-[border-color] duration-150",
                  scrolled ? "border-b border-border" : "border-b border-transparent",
                ].join(" ")}
              />
              <main
                ref={(el) => {
                  mainRef.current = el;
                  if (!el) {
                    setScrolled(false);
                    return;
                  }
                  const onScroll = () => setScrolled(el.scrollTop > 0);
                  onScroll();
                  el.addEventListener("scroll", onScroll, { passive: true });
                  // Cleanup handled when ref unmounts (el = null branch above).
                }}
                key={pathname}
                className="flex-1 min-h-0 overflow-y-auto bg-bg [scrollbar-gutter:stable] [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
              >
                <Outlet context={outletContext} />
              </main>
            </div>
          </div>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}
