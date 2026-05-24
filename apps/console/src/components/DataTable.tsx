import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  EyeIcon,
  EyeOffIcon,
  FilterIcon,
  SearchIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type Table as TanstackTable,
  type Column,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { Skeleton } from "./Skeleton";
import { cn } from "@/lib/utils";

/**
 * DataTable — Excel-like list page chrome.
 *
 * Built on TanStack Table (headless) + shadcn `<Table>` primitives.
 * Replaces the simpler `<ListPage>` for pages that need:
 *
 *   - Click-header sorting (single + multi via shift-click).
 *   - Per-column filter from a header popover (Excel autofilter
 *     pattern) — text input for plain string columns.
 *   - Top toolbar with global search + a "Columns" dropdown for
 *     showing/hiding columns.
 *   - Sticky header (top-0 of <main>, pinned under PageHeader).
 *   - IntersectionObserver-driven load-more for infinite scroll
 *     (same API as ListPage — `hasMore` / `loadingMore` / `onLoadMore`).
 *
 * Caveat: sorting + per-column filter operate on CURRENTLY LOADED rows.
 * For full-corpus sort/filter the server endpoint would have to accept
 * the relevant query params and we'd lift this state into the query
 * key. Today's lists are cursor-paginated forward-only — operating on
 * loaded rows is the same trade-off Linear / Notion / Vercel make on
 * their large views.
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

  /** Page-specific filter slot — tabs, archive toggle, etc. */
  filters?: ReactNode;

  /** TanStack column definitions. Each column should set `id` (or
   *  derive from `accessorKey`) so column visibility / filter state can
   *  key by it. Use `enableSorting: false` / `enableColumnFilter: false`
   *  to opt out per column. */
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
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const showCreate = !!onCreate && !!createLabel;
  const hasToolbar = !!onSearchChange || !!filters;

  const actions =
    headerActions || showCreate ? (
      <>
        {headerActions}
        {showCreate && <Button onClick={onCreate}>{createLabel}</Button>}
      </>
    ) : undefined;

  // Top toolbar — search on the left, filter chips next, columns
  // dropdown pinned right. Columns dropdown reveals every column with
  // a checkbox so users can hide/show without touching code.
  const toolbar = (
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
          <tr key={headerGroup.id} className="border-b border-border">
            {headerGroup.headers.map((header) => (
              <th
                key={header.id}
                className="h-9 px-3 text-left text-xs font-medium align-middle whitespace-nowrap"
              >
                {header.isPlaceholder ? null : (
                  <div className="flex items-center gap-1">
                    <SortableHeader column={header.column}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </SortableHeader>
                    {header.column.getCanFilter() && (
                      <ColumnFilterPopover column={header.column} />
                    )}
                  </div>
                )}
              </th>
            ))}
          </tr>
        ))}
      </thead>
    </table>
  ) : undefined;

  return (
    <Page
      header={
        <PageHeader
          title={title}
          subtitle={subtitle}
          actions={actions}
          toolbar={toolbar}
          tableHeader={frozenHeader}
        />
      }
    >
      {loading ? (
        <SkeletonRows colSpan={visibleColumnCount} />
      ) : isEmpty ? (
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
          {/* Body table: same colgroup as the frozen header so columns
              align. `border-separate border-spacing-y-1.5` turns each
              <tr> into a pill (rounded ends, gap between rows). */}
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
                      "[&>td]:border-y [&>td]:border-border [&>td]:bg-transparent [&>td]:px-3 [&>td]:py-2 [&>td]:align-middle [&>td]:text-sm",
                      "[&>td:first-child]:border-l [&>td:first-child]:rounded-l-lg",
                      "[&>td:last-child]:border-r [&>td:last-child]:rounded-r-lg",
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
    </Page>
  );
}

/** Header content + ▲▼ sort indicator. Clicking toggles asc → desc →
 *  clear. Columns can opt out via `enableSorting: false`. */
function SortableHeader<T>({
  column,
  children,
}: {
  column: Column<T, unknown>;
  children: ReactNode;
}) {
  const canSort = column.getCanSort();
  const sortDir = column.getIsSorted();

  if (!canSort) return <span className="font-medium">{children}</span>;

  const Icon =
    sortDir === "asc" ? ArrowUpIcon : sortDir === "desc" ? ArrowDownIcon : ArrowUpDownIcon;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        column.toggleSorting(undefined, e.shiftKey);
      }}
      className={cn(
        "inline-flex items-center gap-1 font-medium hover:text-fg",
        sortDir && "text-fg",
      )}
    >
      {children}
      <Icon className={cn("size-3", !sortDir && "opacity-40")} />
    </button>
  );
}

/** Excel-style per-column filter popover. Triggered by the funnel icon
 *  inside each filterable header. Text input filters via TanStack's
 *  default includesString matcher. */
function ColumnFilterPopover<T>({ column }: { column: Column<T, unknown> }) {
  const value = (column.getFilterValue() as string | undefined) ?? "";
  const active = value.length > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex items-center justify-center size-5 rounded text-fg-subtle hover:bg-bg-surface hover:text-fg-muted",
            active && "text-brand bg-brand-subtle hover:bg-brand-subtle hover:text-brand",
          )}
          aria-label={`Filter ${String(column.id)}`}
        >
          <FilterIcon className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2 space-y-2">
        <div className="text-xs font-medium text-fg-muted px-1">
          Filter {String(column.id)}
        </div>
        <Input
          value={value}
          onChange={(e) => column.setFilterValue(e.target.value)}
          placeholder="Contains…"
          autoFocus
        />
        {active && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => column.setFilterValue(undefined)}
            className="w-full justify-start"
          >
            <XIcon className="size-3.5" />
            Clear
          </Button>
        )}
      </PopoverContent>
    </Popover>
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
        <Button variant="outline" size="sm" className="ml-auto shrink-0">
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
    <div className="px-4 md:px-8 lg:px-10">
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

// Suppress unused-import lints — these are explicitly re-used by the
// type-only `Column` import above for the helper signatures.
void useMemo;
