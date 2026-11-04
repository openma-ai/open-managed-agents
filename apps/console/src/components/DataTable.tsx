import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { EyeIcon, EyeOffIcon, SearchIcon, SettingsIcon, PlusIcon } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "./Skeleton";
import { OverflowText } from "./ui/overflow-text";

export interface DataTableProps<T> {
  selectable?: boolean;
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
  /** Content below the rows that scrolls with them, such as suggestions. */
  footer?: ReactNode;
}

/** Canonical list layout: a frozen toolbar/header stack followed by a scrolling
 * body. Header and body intentionally use separate tables with identical
 * colgroups; horizontal body scroll is mirrored into the clipped header. */
export function DataTable<T>({
  title,
  selectable = false,
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
  rowActions,
  hasMore,
  onLoadMore,
  loadingMore,
  children,
  footer,
}: DataTableProps<T>) {
  const { t } = useI18n();
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

  const [rowSelection, setRowSelection] = useState({});
  const table = useReactTable({
    data,
    columns: selectable ? [
      {
        id: "selection",
        size: 40,
        enableHiding: false,
        header: ({ table }) => (
          <Checkbox
            aria-label={t.common.selectAll}
            checked={table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && "indeterminate")}
            onCheckedChange={(value) => table.toggleAllRowsSelected(!!value)}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label={`${t.common.selectRow} ${row.id}`}
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
          />
        ),
      },
      ...columns,
    ] : columns,
    state: { columnVisibility, rowSelection },
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    defaultColumn: {
      cell: ({ getValue }) => {
        const value = getValue();
        return typeof value === "string" || typeof value === "number"
          ? <OverflowText>{value}</OverflowText>
          : null;
      },
    },
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
        {subtitle && (
          <header className="flex items-start justify-between px-[var(--list-frame-inset)] pt-5 pb-3">
            <div>
              <h1 className="text-xl font-semibold">{title}</h1>
              <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>
            </div>
            {showCreate && (
              <Button onClick={onCreate}>
                <PlusIcon className="size-4" aria-hidden="true" />
                {createLabel}
              </Button>
            )}
          </header>
        )}
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
            {showCreate && !subtitle && <Button onClick={onCreate}>{createLabel}</Button>}
            {filters}
            {!subtitle && <div className="console-list-toolbar-spacer" />}
            {onSearchChange && (
              <InputGroup className={cn("console-list-search", subtitle && "order-first mr-2 w-80 shrink-0")}>
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
            {!subtitle && <ColumnVisibilityMenu table={table} />}
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
          data-has-footer={footer ? true : undefined}
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
            <div className={subtitle ? "px-[var(--list-frame-inset)] pt-2" : "console-list-empty"}>
              <EmptyState
                className={subtitle ? "flex min-h-[350px] flex-col items-center justify-center [&>div]:max-w-sm" : undefined}
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
                          tabIndex={onRowClick || actions.length > 0 ? 0 : undefined}
                          onClick={onRowClick ? (event) => {
                            // Native Enter on a nested control also emits a click.
                            if ((event.target as Element).closest("a, button, input, select, textarea, [contenteditable=true], [role=button], [role=checkbox], [role=switch], [role=combobox]")) return;
                            onRowClick(row.original);
                          } : undefined}
                          onKeyDown={onRowClick ? (event) => {
                            // Nested inputs/links keep their own keyboard behaviour.
                            if (event.target !== event.currentTarget || event.defaultPrevented || event.repeat) return;
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onRowClick(row.original);
                            }
                          } : undefined}
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
          {footer && <div className="console-list-footer">{footer}</div>}
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
                "h-3 bg-fg/10",
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
