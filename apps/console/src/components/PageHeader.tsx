import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOutletContext } from "react-router";

import { cn } from "@/lib/utils";

import type { AppOutletContext } from "./AppShell";

/**
 * Page header — rendered via React portal into AppShell's
 * `pageHeaderSlot`, which sits ABOVE the scroll container as a
 * `shrink-0` sibling. The slot literally cannot scroll, so the header
 * never moves; no sticky positioning required.
 *
 * All slots are optional. Skipping `title` is common for list pages —
 * the AppBreadcrumb in the top toolbar already identifies the route
 * ("Model Cards" sits above the panel), so repeating it as an `<h1>`
 * is duplicative. List pages typically pass only `actions` + `toolbar`
 * so the header row contains "+ New X" / search / filters and nothing
 * else. Detail pages still set a `title` for the real entity name
 * (e.g. an agent or memory store display name) that the breadcrumb's
 * generic label doesn't carry.
 *
 * Returns null when the slot isn't mounted (e.g. rendered outside
 * AppShell), so pages won't crash if called from an unauthenticated
 * shell-less route, or when neither title/subtitle/actions/toolbar
 * are provided (nothing to render).
 */
interface PageHeaderProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  toolbar,
  className,
}: PageHeaderProps) {
  const ctx = useOutletContext<AppOutletContext | undefined>();
  const slot = ctx?.pageHeaderSlot;
  if (!slot) return null;

  const hasTopRow = !!title || !!subtitle || !!actions;
  if (!hasTopRow && !toolbar) return null;

  return createPortal(
    <div className={cn("bg-bg", className)}>
      {hasTopRow && (
        <div className="flex items-start gap-4 px-4 py-3 md:px-8 lg:px-10">
          <div className="min-w-0 flex-1">
            {title && (
              <h1 className="text-xl font-semibold tracking-tight truncate">
                {title}
              </h1>
            )}
            {subtitle && (
              <p className="text-sm text-fg-muted mt-0.5">{subtitle}</p>
            )}
          </div>
          {actions && (
            <div className="flex items-center gap-2 shrink-0">{actions}</div>
          )}
        </div>
      )}
      {toolbar && (
        <div className="flex items-center gap-2 px-4 py-3 md:px-8 lg:px-10 overflow-x-auto">
          {toolbar}
        </div>
      )}
    </div>,
    slot,
  );
}
