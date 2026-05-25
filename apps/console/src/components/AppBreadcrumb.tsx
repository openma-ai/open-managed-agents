import { Fragment } from "react";
import { Link, useMatches, type UIMatch } from "react-router";
import { ChevronRightIcon } from "lucide-react";

import {
  Breadcrumb as ShadcnBreadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

/**
 * Route handle contract for breadcrumbs. Each route in main.tsx can
 * declare:
 *
 *   handle: { crumb: "Sessions" }                          // fixed label
 *   handle: { crumb: (m) => ({ label: m.data.name }) }      // dynamic
 *   handle: { crumb: (m) => m.params.id ?? "Session" }     // route param
 *
 * Detail routes use the callback form so the leaf crumb displays the
 * real entity id (e.g. `sess-7ywhtwnwvpdtoy31`) — the in-page
 * `← Sessions / sess-xxx` row has been removed, so the breadcrumb is
 * now the canonical place to read the id. Truncation in the leaf
 * `<BreadcrumbPage>` keeps long ids from pushing the toolbar wider.
 *
 * Pages that don't publish a `crumb` are skipped — the URL segment
 * fallback that an earlier draft used was dropped because it added
 * noise for placeholder routes that aren't navigated to as themselves
 * (e.g. `/integrations` parent that just hosts children).
 */
type CrumbValue = string | { label: string; to?: string };
type CrumbHandle = { crumb?: CrumbValue | ((m: UIMatch) => CrumbValue) };

/**
 * AppShell breadcrumb. Walks the active route match chain via
 * `useMatches()` (data-router-only — main.tsx switched to
 * `createBrowserRouter` so this works) and renders the per-route
 * `handle.crumb` values, last as plain text and preceding as links.
 *
 * Hidden when there are no crumbs (root index route or routes without
 * a `crumb` handle) so the top toolbar reads clean.
 */
export function AppBreadcrumb() {
  const matches = useMatches();

  const crumbs = matches
    .map((m) => {
      const handle = (m.handle ?? {}) as CrumbHandle;
      const raw =
        typeof handle.crumb === "function" ? handle.crumb(m) : handle.crumb;
      if (!raw) return null;
      const c = typeof raw === "string" ? { label: raw } : raw;
      return { label: c.label, to: c.to ?? m.pathname };
    })
    .filter((c): c is { label: string; to: string } => c !== null);

  if (crumbs.length === 0) return null;

  return (
    <ShadcnBreadcrumb>
      <BreadcrumbList>
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <Fragment key={`${c.to}-${i}`}>
              {i > 0 && (
                <BreadcrumbSeparator>
                  <ChevronRightIcon className="size-3.5" />
                </BreadcrumbSeparator>
              )}
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage
                    className="truncate max-w-[200px] sm:max-w-[280px]"
                    title={c.label}
                  >
                    {c.label}
                  </BreadcrumbPage>
                ) : (
                  // asChild + React Router <Link> gives an SPA-style
                  // navigation. Without this, BreadcrumbLink renders a
                  // bare <a href> and clicking the breadcrumb does a
                  // full browser reload — losing all in-memory state
                  // (TQ cache, route state, dialogs).
                  <BreadcrumbLink asChild>
                    <Link to={c.to}>{c.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </ShadcnBreadcrumb>
  );
}
