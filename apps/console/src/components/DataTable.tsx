import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { EyeIcon, EyeOffIcon, SearchIcon, SettingsIcon } from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Table as TanstackTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { useLocation } from "react-router";

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
import { cn } from "@/lib/utils";

import { useI18n } from "../i18n";
import { EmptyState, type EmptyStateKind } from "./EmptyState";
import { RowContextMenu, type RowAction } from "./RowContextMenu";
import { Skeleton } from "./Skeleton";

export interface DataTableProps<T> {
  title?: string;
  subtitle?: ReactNode;
  createLabel?: string;
  onCreate?: () => void;
  headerActions?: ReactNode;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  filters?: ReactNode;
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
  rowActions?: (item: T) => RowAction[];
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  children?: ReactNode;
}

/** Canonical list layout: a frozen toolbar/header stack followed by a scrolling
 * body. Header and body intentionally use separate tables with identical
 * colgroups; horizontal body scroll is mirrored into the clipped header. */
export function DataTable<T>({
  title,
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
  rowActions,
  hasMore,
  onLoadMore,
  loadingMore,
  children,
}: DataTableProps<T>) {
  const { pathname } = useLocation();
  const storageKey = `dt-cols:${pathname}`;
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as VisibilityState) : {};
    } catch {
      return {};
    }
  });
  const [gridScrolled, setGridScrolled] = useState(false);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const headerIdPrefix = useId();

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(columnVisibility));
    } catch {
      // Persistence is a convenience; private-mode failures must not block lists.
    }
  }, [storageKey, columnVisibility]);

  const table = useReactTable({
    data,
    columns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
  });

  const rows = table.getRowModel().rows;
  const visibleColumns = table.getAllColumns().filter((column) => column.getIsVisible());
  const isEmpty = !loading && rows.length === 0;
  const showCreate = Boolean(onCreate && createLabel);
  const tableWidth = Math.max(table.getTotalSize(), 1);
  const tableMinWidth = `${tableWidth}px`;
  const trackMinWidth = `calc(${tableWidth}px + var(--list-frame-inset) + var(--list-frame-inset))`;
  const renderColgroup = () => (
    <colgroup>
      {visibleColumns.map((column) => (
        <col key={column.id} style={{ width: `${column.getSize()}px` }} />
      ))}
    </colgroup>
  );

  return (
    <>
      <section
        className="console-list-root"
        data-list-root
        data-testid="data-table-list-root"
        aria-label={title}
      >
        <div
          className="console-list-fixed-header"
          data-scrolled={String(gridScrolled)}
          data-testid="frozen-data-header"
        >
          <div
            className="console-list-toolbar"
            data-list-toolbar
            role="toolbar"
            aria-label={title ? `${title} controls` : "List controls"}
          >
            {headerActions}
            {showCreate && <Button onClick={onCreate}>{createLabel}</Button>}
            {filters}
            <div className="console-list-toolbar-spacer" />
            {onSearchChange && (
              <InputGroup className="console-list-search">
                <InputGroupAddon>
                  <SearchIcon className="size-3.5 opacity-50" />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  value={searchValue ?? ""}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder={searchPlaceholder ?? "Search..."}
                  autoComplete="off"
                  name="oma-list-search"
                />
              </InputGroup>
            )}
            <ColumnVisibilityMenu table={table} />
          </div>

          {!isEmpty && (
            <div
              ref={headerScrollRef}
              className="console-data-head-viewport"
              data-testid="data-header-scroll"
            >
              <div
                className="console-data-track console-data-header-cushion"
                style={{ minWidth: trackMinWidth }}
              >
                <Table
                  container={false}
                  className="console-data-table console-data-header-table"
                  style={{ minWidth: tableMinWidth }}
                  data-testid="data-header-table"
                  aria-label={title ? `${title} columns` : "List columns"}
                >
                  {renderColgroup()}
                  <TableHeader variant="wireless" className="console-data-head">
                    {table.getHeaderGroups().map((headerGroup) => (
                      <TableRow variant="wireless" key={headerGroup.id}>
                        {headerGroup.headers.map((header) => (
                          <TableHead
                            key={header.id}
                            id={`${headerIdPrefix}-${header.column.id}`}
                            scope="col"
                          >
                            <div className="console-data-cell-inner">
                              {header.isPlaceholder
                                ? null
                                : flexRender(header.column.columnDef.header, header.getContext())}
                            </div>
                          </TableHead>
                        ))}
                      </TableRow>
                    ))}
                  </TableHeader>
                </Table>
              </div>
            </div>
          )}
        </div>

        <div
          className="console-data-grid-viewport"
          data-grid-viewport
          data-testid="data-grid-viewport"
          onScroll={(event) => {
            if (headerScrollRef.current) {
              headerScrollRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }
            const next = event.currentTarget.scrollTop > 0;
            setGridScrolled((current) => (current === next ? current : next));
          }}
        >
          {isEmpty ? (
            <div className="console-list-empty">
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
            <div
              className="console-data-track console-data-grid-cushion"
              style={{ minWidth: trackMinWidth }}
            >
              <Table
                container={false}
                className="console-data-table console-data-body-table"
                style={{ minWidth: tableMinWidth }}
                data-testid="data-body-table"
                aria-label={title ?? "List data"}
              >
                {renderColgroup()}
                <TableBody>
                  {loading ? (
                    <SkeletonRows columnCount={visibleColumns.length} />
                  ) : (
                    rows.map((row) => {
                      const actions = rowActions?.(row.original) ?? [];
                      const rowElement = (
                        <TableRow
                          key={row.id}
                          variant="wireless"
                          className={cn(
                            "console-data-row",
                            onRowClick && "is-interactive",
                            actions.length > 0 && "has-context-menu",
                          )}
                          data-context-menu={actions.length > 0 || undefined}
                          tabIndex={actions.length > 0 ? 0 : undefined}
                          onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell
                              key={cell.id}
                              headers={`${headerIdPrefix}-${cell.column.id}`}
                            >
                              <div className="console-data-cell-inner">
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </div>
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                      return actions.length > 0 ? (
                        <RowContextMenu key={row.id} actions={actions}>
                          {rowElement}
                        </RowContextMenu>
                      ) : (
                        rowElement
                      );
                    })
                  )}
                  {!loading && onLoadMore && hasMore && (
                    <LoadMoreRow
                      colSpan={visibleColumns.length}
                      loading={Boolean(loadingMore)}
                      onLoadMore={onLoadMore}
                    />
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </section>
      {children}
    </>
  );
}

function ColumnVisibilityMenu<T>({ table }: { table: TanstackTable<T> }) {
  const hideableColumns = table.getAllColumns().filter((column) => column.getCanHide());
  const { t } = useI18n();
  if (hideableColumns.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="shrink-0">
          <SettingsIcon className="size-3.5" />
          {t.common.columns}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs uppercase tracking-wider text-fg-subtle font-medium">
          {t.common.visibleColumns}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hideableColumns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            onCheckedChange={(value) => column.toggleVisibility(Boolean(value))}
            onSelect={(event) => event.preventDefault()}
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

function SkeletonRows({ columnCount }: { columnCount: number }) {
  return Array.from({ length: 10 }).map((_, rowIndex) => (
    <TableRow variant="wireless" key={`skeleton-${rowIndex}`} className="console-data-row console-data-row-skeleton">
      {Array.from({ length: columnCount }).map((__, columnIndex) => (
        <TableCell key={columnIndex}>
          <div className="console-data-cell-inner">
            <Skeleton
              className={cn(
                "h-3",
                columnIndex === 0
                  ? rowIndex % 2 === 0
                    ? "w-[55%]"
                    : "w-[42%]"
                  : rowIndex % 3 === 0
                    ? "w-[80%]"
                    : "w-[62%]",
              )}
              rounded="sm"
            />
          </div>
        </TableCell>
      ))}
    </TableRow>
  ));
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
  const { t } = useI18n();
  const ref = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !loading) onLoadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading, onLoadMore]);

  return (
    <TableRow variant="wireless" ref={ref} className="console-data-load-more">
      <TableCell colSpan={colSpan}>{loading ? t.common.loadingMore : " "}</TableCell>
    </TableRow>
  );
}

export { type ColumnDef } from "@tanstack/react-table";
