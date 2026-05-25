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
 * Four slots, all optional:
 *   - `title`        → page name (usually omitted; AppBreadcrumb
 *                      already names the route at the top of the shell)
 *   - `subtitle`     → optional one-liner under the title
 *   - `actions`      → right-side button row (filters, CTAs)
 *   - `toolbar`      → second row below the title for search / chips
 *   - `tableHeader`  → bottom row for a frozen list-table header
 *                      (Excel-style). DataTable renders its `<thead>`
 *                      table here so column labels physically live
 *                      outside the scroll container and CAN'T move.
 *
 * Sections flow into each other WITHOUT internal dividers — the only
 * border is the scroll-shadow line added by AppShell's pageHeaderSlot
 * wrapper, which fades in once the user scrolls the panel content
 * under the header. Matches the LangSmith / Linear / Vercel pattern:
 * a flat header block, separator appears only when there's content
 * actually being hidden by it.
 *
 * Returns null when the slot isn't mounted, or when no slot has content.
 */
interface PageHeaderProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  tableHeader?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  toolbar,
  tableHeader,
  className,
}: PageHeaderProps) {
  const ctx = useOutletContext<AppOutletContext | undefined>();
  const slot = ctx?.pageHeaderSlot;
  if (!slot) return null;

  const hasTopRow = !!title || !!subtitle || !!actions;
  if (!hasTopRow && !toolbar && !tableHeader) return null;

  return createPortal(
    <div className={cn("bg-bg", className)}>
      {hasTopRow && (
        <div className="flex items-start gap-4 pl-3 pr-4 pt-3">
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
        <div className="flex items-center gap-2 pl-3 pr-4 py-3 overflow-x-auto">
          {toolbar}
        </div>
      )}
      {tableHeader && (
        <div className="pl-3 pr-4">
          {tableHeader}
        </div>
      )}
    </div>,
    slot,
  );
}
