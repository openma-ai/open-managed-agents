import { useMatches, type UIMatch } from "react-router";
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
 * Crumb shape exposed by route handles. Pages can publish a static label
 * via the route definition or a dynamic one via the loader/match data;
 * this header reads `match.handle.crumb` first, falling back to the URL
 * segment if a route doesn't declare one. Pure derivation, no global
 * registry to fall out of sync.
 *
 *     // in routes
 *     {
 *       path: "agents",
 *       handle: { crumb: "Agents" },
 *       element: <AgentsList />,
 *     }
 */
export interface RouteCrumb {
  label: string;
  /** When set, render as a link to this path instead of plain text. */
  to?: string;
}

type CrumbHandle = { crumb?: string | ((m: UIMatch) => RouteCrumb | string | null) };

/**
 * Path-segment fallback when a route doesn't declare its own crumb.
 * Maps known top-level routes to friendly names; unknown segments fall
 * back to start-cased text. Hides the implicit "" segment for "/".
 */
const FALLBACK_LABELS: Record<string, string> = {
  agents: "Agents",
  sessions: "Sessions",
  files: "Files",
  evals: "Eval Runs",
  environments: "Environments",
  vaults: "Credential Vaults",
  skills: "Skills",
  memory: "Memory Stores",
  "model-cards": "Model Cards",
  "api-keys": "API Keys",
  runtimes: "Local Runtimes",
  integrations: "Integrations",
  linear: "Linear",
  github: "GitHub",
  slack: "Slack",
};

function titleize(seg: string): string {
  const known = FALLBACK_LABELS[seg];
  if (known) return known;
  return seg
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/**
 * AppShell breadcrumb — derives crumbs from the active route chain.
 *
 *   - Skips the root "/" match (handled by the brand + sidebar).
 *   - Resource detail routes (`/sessions/:id`) show the raw id when the
 *     route doesn't override via `handle.crumb`; pages with their own
 *     name (e.g. agent display name) should set
 *     `handle: { crumb: (m) => ({ label: m.data.name }) }`.
 *   - Last crumb is plain text (`BreadcrumbPage`), preceding ones are
 *     links back to that level.
 */
export function AppBreadcrumb() {
  const matches = useMatches();

  // Strip the root match — covered by the brand. Map remaining matches
  // to crumbs, deriving from handle.crumb or URL fallback.
  const crumbs = matches
    .filter((m) => m.pathname !== "/")
    .map((m) => {
      const handle = (m.handle ?? {}) as CrumbHandle;
      const raw = typeof handle.crumb === "function" ? handle.crumb(m) : handle.crumb;
      if (raw) {
        const c = typeof raw === "string" ? { label: raw } : raw;
        return { label: c.label, to: c.to ?? m.pathname };
      }
      // URL fallback: take the last non-empty path segment.
      const segs = m.pathname.split("/").filter(Boolean);
      const last = segs[segs.length - 1];
      if (!last) return null;
      return { label: titleize(last), to: m.pathname };
    })
    .filter((c): c is { label: string; to: string } => c !== null);

  if (crumbs.length === 0) return null;

  return (
    <ShadcnBreadcrumb>
      <BreadcrumbList>
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <span key={c.to} className="contents">
              {i > 0 && (
                <BreadcrumbSeparator>
                  <ChevronRightIcon className="size-3.5" />
                </BreadcrumbSeparator>
              )}
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={c.to}>{c.label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </span>
          );
        })}
      </BreadcrumbList>
    </ShadcnBreadcrumb>
  );
}
