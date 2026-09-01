import { Input } from "@/components/ui/input";
import { useMemo, useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";

import { TooltipProvider } from "@/components/ui/tooltip";

import { useAuth } from "../lib/auth";
import { useChordKeybinding, type ChordBinding } from "../lib/useChordKeybinding";
import { ROUTE_CHORDS } from "../lib/route-chords";
import { AppSidebar } from "./AppSidebar";
import { AppBreadcrumb } from "./AppBreadcrumb";
import { BrandLoader } from "./BrandLoader";
import { CommandPalette } from "./CommandPalette";
import { ConsoleShell } from "./ConsoleShell";
import { NavigationProgress } from "./NavigationProgress";

export interface AppOutletContext {
  pageHeaderSlot: HTMLDivElement | null;
}

export function AppShell() {
  const { isAuthenticated, isLoading } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [pageHeaderSlot, setPageHeaderSlot] = useState<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);

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

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <TooltipProvider delayDuration={250}>
      <NavigationProgress />
      <CommandPalette />

      <div className="console-autofill-honeypot" aria-hidden="true">
        <Input type="text" tabIndex={-1} autoComplete="username" name="username" />
        <Input
          type="password"
          tabIndex={-1}
          autoComplete="current-password"
          name="password"
        />
      </div>

      <ConsoleShell
        sidebar={<AppSidebar />}
        breadcrumb={<AppBreadcrumb />}
        pageHeaderSlotRef={setPageHeaderSlot}
        pageHeaderScrolled={scrolled}
      >
        <main
          key={pathname}
          className="console-route-main"
          onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
        >
          <Outlet context={outletContext} />
        </main>
      </ConsoleShell>
    </TooltipProvider>
  );
}
