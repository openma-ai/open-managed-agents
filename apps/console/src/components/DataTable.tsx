import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  EyeIcon,
  EyeOffIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Table as TanstackTable,
  type VisibilityState,
} from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";

import { EmptyState, type EmptyStateKind } from "./EmptyState";
import { PageHeader } from "./PageHeader";
import { Skeleton } from "./Skeleton";
import { cn } from "@/lib/utils";

/**
 * DataTable — list page chrome with a frozen, column-aligned header.
 *
 * Built on TanStack Table (headless) + shadcn `<Table>` primitives.
 * Used when a page wants:
 *
 *   - A header pinned outside the scroll container (Excel-style frozen
 *     first row, never moves as the body scrolls).
 *   - A toolbar with a server-side global search box, page-specific
 *     filter chips, and a "Columns" dropdown for show/hide.
 *   - IntersectionObserver-driven load-more for infinite scroll (same
 *     API as ListPage — `hasMore` / `loadingMore` / `onLoadMore`).
 *
 * What DataTable deliberately does NOT do:
 *
 *   - **No click-header sorting.** Order is whatever the server returns
 *     (today: `created_at DESC, id DESC` on cursor pages). Adding a
 *     client-side sort over already-loaded rows is a lie when more
 *     pages exist — the next page lands at the bottom in raw order.
 *     If a list needs to be sorted differently, the server endpoint
 *     decides; the UI doesn't pretend.
 *   - **No per-column free-text filter popovers.** Same lie: a contains-
 *     match on loaded rows hides the user's data without telling them.
 *     Structured filters (enum, time bucket) belong in the toolbar
 *     `filters` slot, where each page pushes them as real query params.
 */
export interface DataTableProps<T> {
  /** Page title — usually omitted for list pages where AppBreadcrumb
   *  already names the route at the top of the shell. Detail/sub-views
   *  that need a richer label (entity name) still pass it. */
  title?: string;
  /** Brief one-liner under the title — kept even when title is hidden
   *  so list pages can publish a description. */
  subtitle?: ReactNode;

  /** Primary "create" button. Both must be set to render. */
  createLabel?: string;
  onCreate?: () => void;
  headerActions?: ReactNode;

  /** Server-side search input rendered in the toolbar. */
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (v: string) => void;

  /** Page-specific filter slot — structured chips (status enum,
   *  created-at bucket, agent dropdown). Pages own these and wire them
   *  to real server query params, so the UI doesn't promise filtering
   *  it can't deliver. */
  filters?: ReactNode;

  /** TanStack column definitions. Each column should set `id` (or
   *  derive from `accessorKey`) so column visibility can key by it.
   *  Use `enableHiding: false` to pin a column visible. */
  columns: ColumnDef<T, unknown>[];
  data: T[];
  getRowId: (item: T) => string;

  loading?: boolean;
  emptyTitle?: string;
  emptySubtitle?: ReactNode;
  emptyAction?: ReactNode;
  emptyKind?: EmptyStateKind;
  emptyIcon?: ReactNode;

  onRowClick?: (item: T) => void;

  /** Infinite-scroll mode — paired with `useInfiniteApiQuery`. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;

  children?: ReactNode;
}

export function DataTable<T>({
  title,
  subtitle,
  createLabel,
  onCreate,
  headerActions,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  filters,
  columns,
  data,
  getRowId,
  loading,
  emptyTitle = "Nothing here yet",
  emptySubtitle,
  emptyAction,
  emptyKind,
  emptyIcon,
  onRowClick,
  hasMore,
  onLoadMore,
  loadingMore,
  children,
}: DataTableProps<T>) {
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const table = useReactTable({
    data,
    columns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
  });

  const showCreate = !!onCreate && !!createLabel;

  // Single-row toolbar: [+ New X] on far left, page-specific filter
  // chips next, then a flex spacer pushes [search] + [Columns] to the
  // far right. Matches the LangSmith / Linear / Vercel pattern of one
  // continuous action row above the table (no separate top-right
  // "actions" zone). When there's no createCTA and no filters, the
  // search box still right-aligns via `ml-auto`.
  const toolbar = (
    <>
      {headerActions}
      {showCreate && <Button onClick={onCreate}>{createLabel}</Button>}
      {filters}
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
      <ColumnVisibilityMenu table={table} />
    </>
  );

  const filteredRows = table.getRowModel().rows;
  const isEmpty = !loading && filteredRows.length === 0;
  const visibleColumns = table.getAllColumns().filter((c) => c.getIsVisible());
  const visibleColumnCount = visibleColumns.length;

  // Excel-style frozen column header: rendered as its own <table> inside
  // the PageHeader portal slot, physically OUTSIDE the scroll container.
  // Body table below shares the same colgroup widths via
  // `table-layout: fixed` so columns line up perfectly across both
  // tables. TanStack drives the cell sizes via `column.getSize()`
  // (defaults to 150 per column).
  const colgroup = (
    <colgroup>
      {visibleColumns.map((col) => (
        <col key={col.id} style={{ width: `${col.getSize()}px` }} />
      ))}
    </colgroup>
  );

  const frozenHeader = !loading && !isEmpty ? (
    <table className="w-full table-fixed text-fg-muted">
      {colgroup}
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th
                key={header.id}
                className="h-9 px-3 text-left text-xs font-medium align-middle whitespace-nowrap"
              >
                {header.isPlaceholder ? null : (
                  <span className="font-medium">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </span>
                )}
              </th>
            ))}
          </tr>
        ))}
      </thead>
    </table>
  ) : undefined;

  return (
    <>
      <PageHeader
        toolbar={toolbar}
        tableHeader={frozenHeader}
      />

      {loading ? (
        <SkeletonRows colSpan={visibleColumnCount} />
      ) : isEmpty ? (
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
        <div className="pl-3 pr-4 pb-4">
          {/* Body sits flush against the frozen header in the slot —
              no extra top padding so the gap between header and first
              row is only the row pill's own `border-spacing-y-1.5`
              (6 px). The scroll-shadow line on AppShell's
              pageHeaderSlot is the only horizontal divider that
              appears (only on scroll). */}
          <table className="w-full table-fixed border-separate border-spacing-y-1.5">
            {colgroup}
            <tbody>
              {filteredRows.map((row) => {
                const cells = row.getVisibleCells();
                return (
                  <tr
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    className={cn(
                      "bg-bg-surface/60 hover:bg-bg-surface transition-colors",
                      "[&>td]:bg-transparent [&>td]:px-3 [&>td]:py-2 [&>td]:align-middle [&>td]:text-sm",
                      "[&>td:first-child]:rounded-l-lg",
                      "[&>td:last-child]:rounded-r-lg",
                      onRowClick && "cursor-pointer",
                    )}
                  >
                    {cells.map((cell) => (
                      <td key={cell.id} className="truncate">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {onLoadMore && hasMore && (
                <LoadMoreRow
                  colSpan={visibleColumnCount}
                  loading={!!loadingMore}
                  onLoadMore={onLoadMore}
                />
              )}
            </tbody>
          </table>
        </div>
      )}

      {children}
    </>
  );
}

/** Right-pinned "Columns" toggle in the toolbar — shadcn dropdown
 *  with one checkbox per non-required column. Required columns
 *  (id, name) typically set `enableHiding: false` on their def. */
function ColumnVisibilityMenu<T>({ table }: { table: TanstackTable<T> }) {
  const hideableColumns = table.getAllColumns().filter((c) => c.getCanHide());
  if (hideableColumns.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="ml-auto shrink-0">
          <SettingsIcon className="size-3.5" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-fg-subtle font-medium">
          Visible columns
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hideableColumns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            onCheckedChange={(value) => column.toggleVisibility(!!value)}
            // Keep menu open while toggling several columns in a row.
            onSelect={(e) => e.preventDefault()}
            className="capitalize"
          >
            {column.getIsVisible() ? (
              <EyeIcon className="size-3.5 opacity-60" />
            ) : (
              <EyeOffIcon className="size-3.5 opacity-60" />
            )}
            {String(column.id)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Same skeleton recipe as ListPage so loading state stays consistent
 *  across both list variants. */
function SkeletonRows({ colSpan }: { colSpan: number }) {
  return (
    <div className="pl-3 pr-4">
      <Table>
        <TableBody>
          {Array.from({ length: 10 }).map((_, rowIdx) => (
            <TableRow key={`sk-${rowIdx}`}>
              {Array.from({ length: colSpan || 4 }).map((_, colIdx) => {
                const widthClass = (() => {
                  if (colIdx === 0) return rowIdx % 2 === 0 ? "w-[55%]" : "w-[42%]";
                  if (colIdx === colSpan - 1)
                    return rowIdx % 2 === 0 ? "w-[38%]" : "w-[48%]";
                  return rowIdx % 3 === 0 ? "w-[85%]" : rowIdx % 3 === 1 ? "w-[72%]" : "w-[60%]";
                })();
                return (
                  <TableCell key={colIdx}>
                    <Skeleton className={`h-3.5 ${widthClass}`} rounded="sm" />
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

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

// Re-export for caller-side column definitions.
export { type ColumnDef } from "@tanstack/react-table";
