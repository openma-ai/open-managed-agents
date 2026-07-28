import { useEffect, useRef, type ReactNode } from "react";
import { SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { EmptyState, type EmptyStateKind } from "./EmptyState";
import { Page } from "./Page";
import { PageHeader } from "./PageHeader";
import { Skeleton } from "./Skeleton";

interface Column<T> {
  key: string;
  label: string;
  render?: (item: T) => ReactNode;
  /** Class merged into both the <th> and the <td> for this column. */
  className?: string;
}

interface ListPageProps<T> {
  /** Page title — usually omitted for list pages where AppBreadcrumb
   *  already names the route at the top of the shell. Detail/sub-views
   *  that need a richer label (entity name) still pass it. */
  title?: string;
  /** Subtitle below the title — accepts ReactNode so callers can drop in
   *  inline `<code>` snippets, links, etc. */
  subtitle?: ReactNode;

  /** Primary "create" button. Both must be set for the button to render —
   *  read-only pages (EvalRunsList) just omit them. */
  createLabel?: string;
  onCreate?: () => void;

  /** Extra controls rendered alongside the create button (e.g. ClawHub on
   *  SkillsList). */
  headerActions?: ReactNode;

  /** Built-in search input. Render only when `onSearchChange` is provided. */
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (v: string) => void;

  /** Built-in "Show archived" checkbox. Render only when the change handler
   *  is provided. Pages that drive this server-side just wire it through. */
  showArchived?: boolean;
  onShowArchivedChange?: (v: boolean) => void;

  /** Extra filter controls rendered alongside search/archived in the toolbar
   *  row — e.g. an agent dropdown (SessionsList) or all/active tabs. */
  filters?: ReactNode;

  /** Standard table columns. Cell rendering is via `render` or, if absent,
   *  string coercion of `item[key]`. */
  columns: Column<T>[];
  data: T[];

  loading?: boolean;
  emptyTitle?: string;
  /** ReactNode so callers can include code snippets, links etc. */
  emptySubtitle?: ReactNode;
  /** Action slot rendered inside the empty state — typically a Button
   *  that opens the create dialog so the empty state isn't a dead end. */
  emptyAction?: ReactNode;
  /** Entity-specific illustration shown above the empty-state title.
   *  Omit to fall back to the `[ ]` brand glyph. */
  emptyKind?: EmptyStateKind;
  /** Custom illustration override for the empty state. Wins over
   *  `emptyKind` when both are set. */
  emptyIcon?: ReactNode;

  onRowClick?: (item: T) => void;
  getRowKey: (item: T) => string;

  /** Infinite-scroll mode (paired with `useInfiniteApiQuery`). When
   *  `onLoadMore` is set and `hasMore` is true, ListPage mounts an
   *  IntersectionObserver near the table foot that triggers a fetch as
   *  the user scrolls into range. `loadingMore` flips during the in-
   *  flight fetch so the spinner row renders. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;

  /** Anything to render below the table — typically modals tied to the
   *  page (create dialog, detail dialog, etc.). */
  children?: ReactNode;
}

/**
 * Reusable list-page chrome. Modern SaaS pattern (LangSmith, Linear,
 * Vercel, Plane) — single filter-header at the top, infinite scroll in
 * the body, no Prev/Next/numbered footer:
 *
 *   - Sticky `PageHeader` with title + primary CTA + a `toolbar` row
 *     hosting search, archived toggle, and per-page filter chips.
 *   - shadcn `Table` shell with a sticky `<thead>` (top-0 of <main>,
 *     pinned directly under the PageHeader).
 *   - IntersectionObserver-driven "load more" — sentinel `<tr>` below
 *     the last row asks `onLoadMore` to fetch the next cursor page as
 *     it scrolls into view. Loading spinner row keeps the layout
 *     stable across fetches.
 *
 * Pages keep ownership of their modals — pass them via `children`. Any
 * truly per-page filter UI (tabs, dropdowns) goes through the `filters`
 * slot.
 */
export function ListPage<T>({
  title,
  subtitle,
  createLabel,
  onCreate,
  headerActions,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  showArchived,
  onShowArchivedChange,
  filters,
  columns,
  data,
  loading,
  emptyTitle = "Nothing here yet",
  emptySubtitle,
  emptyAction,
  emptyKind,
  emptyIcon,
  onRowClick,
  getRowKey,
  hasMore,
  onLoadMore,
  loadingMore,
  children,
}: ListPageProps<T>) {
  const showCreate = !!onCreate && !!createLabel;

  // Single-row toolbar: [+ New X] far left → filter chips + archive
  // toggle → spacer → [search] far right. Matches the LangSmith /
  // Linear / Vercel single-row pattern. No top-right "actions" zone
  // any more; the create CTA lives inline with the rest of the
  // toolbar so the eye lands in one place.
  const toolbar = (
    <>
      {headerActions}
      {showCreate && <Button onClick={onCreate}>{createLabel}</Button>}
      {filters}
      {onShowArchivedChange && (
        <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer select-none shrink-0">
          <Checkbox
            checked={showArchived ?? false}
            onCheckedChange={(c) => onShowArchivedChange(c === true)}
          />
          Show archived
        </label>
      )}
      <div className="flex-1" />
      {onSearchChange && (
        <InputGroup className="w-full sm:w-64 shrink-0">
          <InputGroupAddon>
            <SearchIcon className="size-3.5 opacity-50" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={searchValue ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder ?? "Search..."}
            autoComplete="off"
            name="oma-list-search"
          />
        </InputGroup>
      )}
    </>
  );

  // Sticky head pins to top of <main> (the scroll context). PageHeader
  // is rendered into a sibling slot ABOVE <main> via portal, so `top-0`
  // here is flush below the page header.
  const tableHeadSticky = "sticky top-0 z-10";

  return (
    <Page header={<PageHeader toolbar={toolbar} />}>
      {loading ? (
        <TableShell columns={columns} headSticky={tableHeadSticky}>
          {/* Skeleton rows — clamped to 10 so empty workspaces don't
              stretch a half-page of empty bars. */}
          {Array.from({ length: 10 }).map((_, rowIdx) => (
            <TableRow key={`sk-${rowIdx}`}>
              {columns.map((col, colIdx) => {
                const widthClass = (() => {
                  if (colIdx === 0) return rowIdx % 2 === 0 ? "w-[55%]" : "w-[42%]";
                  if (colIdx === columns.length - 1)
                    return rowIdx % 2 === 0 ? "w-[38%]" : "w-[48%]";
                  return rowIdx % 3 === 0 ? "w-[85%]" : rowIdx % 3 === 1 ? "w-[72%]" : "w-[60%]";
                })();
                return (
                  <TableCell key={col.key} className={col.className}>
                    <Skeleton className={`h-3.5 ${widthClass}`} rounded="sm" />
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableShell>
      ) : data.length === 0 ? (
        <div className="pl-3 pr-4 py-4">
          <EmptyState
            title={emptyTitle}
            body={emptySubtitle}
            action={emptyAction}
            kind={emptyKind}
            icon={emptyIcon}
            size="lg"
          />
        </div>
      ) : (
        <div className="pl-3 pr-4">
          <TableShell columns={columns} headSticky={tableHeadSticky}>
            {data.map((item) => (
              <TableRow
                key={getRowKey(item)}
                onClick={onRowClick ? () => onRowClick(item) : undefined}
                className={onRowClick ? "cursor-pointer" : undefined}
              >
                {columns.map((col) => (
                  <TableCell key={col.key} className={col.className}>
                    {col.render
                      ? col.render(item)
                      : String((item as Record<string, unknown>)[col.key] ?? "")}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {onLoadMore && hasMore && (
              <LoadMoreRow
                colSpan={columns.length}
                loading={!!loadingMore}
                onLoadMore={onLoadMore}
              />
            )}
          </TableShell>
        </div>
      )}

      {children}
    </Page>
  );
}

interface TableShellProps<T> {
  columns: Column<T>[];
  headSticky: string;
  children: ReactNode;
}

function TableShell<T>({ columns, headSticky, children }: TableShellProps<T>) {
  return (
    <Table>
      {/* Cleaner thead — normal-case xs text with a bg tint that matches
          the rest of the canvas (bg-bg/95 + backdrop-blur lets the row
          beneath bleed through faintly as the user scrolls under it).
          The previous uppercase tracking-wider treatment read as
          dashboard-y / Bootstrap-era; modern app tables (Linear, Vercel,
          Plane) use plain case + subtle weight. */}
      <TableHeader
        className={`${headSticky} bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/80 text-fg-muted`}
      >
        <TableRow className="border-b border-border hover:bg-transparent">
          {columns.map((col) => (
            <TableHead key={col.key} className={`h-9 text-xs font-medium ${col.className ?? ""}`}>
              {col.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

/**
 * Sentinel row mounted below the last data row when more pages exist.
 * IntersectionObserver fires `onLoadMore` as soon as the row scrolls
 * into the visible window — replaces the Prev/Next pagination footer.
 * `loading` flips to true while the fetch is in flight so the row keeps
 * a stable height (spinner instead of a blank cell). The row stays
 * mounted across loads so the observer keeps observing.
 */
function LoadMoreRow({
  colSpan,
  loading,
  onLoadMore,
}: {
  colSpan: number;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const ref = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loading) {
          onLoadMore();
        }
      },
      // rootMargin lets the fetch start while the row is still a screen
      // away — by the time the user scrolls there the next page is
      // already painting.
      { rootMargin: "400px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loading, onLoadMore]);

  return (
    <TableRow ref={ref} className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="text-center py-4 text-xs text-fg-subtle">
        {loading ? "Loading more…" : " "}
      </TableCell>
    </TableRow>
  );
}
