import { type ReactNode } from "react";
import { SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import { Pagination } from "./Pagination";
import { Skeleton } from "./Skeleton";

interface Column<T> {
  key: string;
  label: string;
  render?: (item: T) => ReactNode;
  /** Class merged into both the <th> and the <td> for this column. */
  className?: string;
}

interface ListPageProps<T> {
  /** Page title rendered in the sticky PageHeader. */
  title: string;
  /** Subtitle below the title — accepts ReactNode so callers can drop in
   *  inline `<code>` snippets, links, etc. (e.g. MemoryStoresList shows the
   *  mount path in the subtitle). */
  subtitle: ReactNode;

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

  /** Paginated mode driven by `usePagedList`. When `onPageChange` is set,
   *  the full Pagination component is rendered (numbered pages, page-size
   *  selector, range info). */
  pageIndex?: number;
  pageSize?: number;
  hasNext?: boolean;
  knownPages?: number;
  pageSizeOptions?: number[];
  onPageChange?: (idx: number) => void;
  onPageSizeChange?: (size: number) => void;

  /** Anything to render below the table — typically modals tied to the
   *  page (create dialog, detail dialog, etc.). */
  children?: ReactNode;
}

/**
 * Reusable list-page chrome shared across the console (Sessions, Agents,
 * Environments, etc.). Provides:
 *   - Sticky `PageHeader` (title + subtitle + create CTA).
 *   - Sticky toolbar row inside the header — search, archived toggle,
 *     custom filter slot.
 *   - shadcn `Table` shell with a sticky `<thead>` that pins below the
 *     PageHeader on scroll, so the column labels never disappear.
 *   - Skeleton rows during loading, EmptyState when no data, Pagination
 *     footer when the page list is wired up.
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
  pageIndex,
  pageSize,
  hasNext,
  knownPages,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
  children,
}: ListPageProps<T>) {
  const hasToolbar = !!onSearchChange || !!onShowArchivedChange || !!filters;
  const showCreate = !!onCreate && !!createLabel;

  const actions =
    headerActions || showCreate ? (
      <>
        {headerActions}
        {showCreate && <Button onClick={onCreate}>{createLabel}</Button>}
      </>
    ) : undefined;

  const toolbar = hasToolbar ? (
    <>
      {onSearchChange && (
        <InputGroup className="w-full sm:w-64">
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
    </>
  ) : undefined;

  // Table head pins to the top of <main> (the scroll container in
  // AppShell). PageHeader is rendered via portal into a sibling slot
  // ABOVE <main>, so `top-0` here puts the head flush below the header
  // with no CSS-var coordination needed.
  const tableHeadSticky = "sticky top-0 z-10";

  return (
    <Page header={<PageHeader title={title} subtitle={subtitle} actions={actions} toolbar={toolbar} />}>
      {loading ? (
        <TableShell columns={columns} headSticky={tableHeadSticky}>
          {/* Skeleton rows — clamped to 10 so empty workspaces don't
              stretch a half-page of empty bars, same per-column padding as
              the real table so the cell-grid alignment is identical on
              load. Skeleton bar widths vary per column index to fake
              content density (id columns shorter, name columns longer). */}
          {Array.from({ length: Math.min(pageSize ?? 10, 10) }).map((_, rowIdx) => (
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
        <div className="px-4 py-4 md:px-8 lg:px-10">
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
        <div className="px-4 md:px-8 lg:px-10">
          {/* No outer bordered/overflow-hidden card here on purpose.
              The previous wrapper trapped the sticky <thead> inside its
              own scrolling context (overflow-hidden creates a scroll
              container even if hidden), so the head never pinned to
              <main> on scroll. Rendering the Table directly lets
              `sticky top-0` resolve to <main> like it should. */}
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
          </TableShell>
          {onPageChange && onPageSizeChange && (
            <Pagination
              pageIndex={pageIndex ?? 0}
              pageSize={pageSize ?? 20}
              hasNext={hasNext ?? false}
              knownPages={knownPages ?? 1}
              itemCount={data.length}
              pageSizeOptions={pageSizeOptions}
              loading={loading}
              onPageChange={onPageChange}
              onPageSizeChange={onPageSizeChange}
            />
          )}
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
