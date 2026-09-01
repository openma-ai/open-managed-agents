import { Button } from "@/components/ui/button";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Generic Combobox for "pick one resource from a possibly large list."
 * Replaces native `<select>` everywhere we'd otherwise reach for it.
 *
 * Behavior:
 *   - Closed state: trigger button styled like TextInput; left shows
 *     selected label or placeholder; right ▼.
 *   - Open: shadcn Popover hosts a shadcn Command (cmdk under the hood)
 *     with an input + scrollable list. The popover handles click-outside,
 *     Escape, focus restoration, and collision detection — previously
 *     hand-rolled here with `mousedown` + `keydown` listeners + ref math.
 *   - Empty input: latest 20 from `endpoint`. Scroll to bottom auto-loads
 *     next 20 via IntersectionObserver on a sentinel inside CommandList.
 *   - Typing: 250ms debounce → `?q=...&limit=20`. Same scroll pagination.
 *   - Keyboard: cmdk handles ↑↓ Enter / type-to-search; Popover handles Esc.
 *   - Preset value not in current page → one-shot `GET endpoint/value` to
 *     resolve the label, cached by TanStack Query.
 *
 * Why this exists: native `<select>`s in the console fetched `?limit=200`
 * up front and silently truncated past 200. Combobox + server-side `?q=`
 * (added in apps/main/src/lib/list-page.ts) fixes that without a UI lib's
 * worth of new patterns to learn.
 *
 * Fetch backbone: TanStack Query's `useInfiniteQuery`, which gives us
 *   - dedup across multiple Combobox instances on the same endpoint
 *   - tab-focus revalidation
 *   - AbortSignal-based cancellation on unmount
 *   - request-race protection (stale resolves dropped automatically)
 * `placeholderData: keepPreviousData` keeps the prior results visible
 * during a refetch so the dropdown doesn't flicker to "No results"
 * mid-search.
 */

interface PageResponse<T> {
  data: T[];
  next_page?: string | null;
  next_cursor?: string | null;
}

type PaginationContract = "managed" | "oma";

export function buildComboboxPageUrl(
  endpoint: string,
  opts: {
    limit: number;
    page?: string;
    search?: string;
    searchParam?: "q";
    pagination?: PaginationContract;
  },
): string {
  const sp = new URLSearchParams();
  sp.set("limit", String(opts.limit));
  if (opts.page) {
    sp.set(opts.pagination === "oma" ? "cursor" : "page", opts.page);
  }
  if (opts.search && opts.searchParam) {
    sp.set(opts.searchParam, opts.search);
  }
  return `${endpoint}?${sp}`;
}

export function readComboboxNextPage(page: {
  data?: unknown[];
  next_page?: string | null;
  next_cursor?: string | null;
}, pagination: PaginationContract = "managed"): string | undefined {
  return pagination === "oma"
    ? page.next_cursor ?? undefined
    : page.next_page ?? undefined;
}

export interface ComboboxProps<T> {
  value: string;
  onValueChange: (value: string, item: T | null) => void;
  /** Managed API path, e.g. "/v1/agents". Feed transport uses `page`/`next_page`. */
  endpoint: string;
  /** Stable id extractor for an item. */
  getValue: (item: T) => string;
  /** Renderable label for an item — used both in trigger and rows. */
  getLabel: (item: T) => ReactNode;
  /** Plain-text label for the trigger when an item is selected; falls back
   *  to `String(getValue(item))` when omitted. Provide for items where
   *  `getLabel` returns JSX. */
  getTextLabel?: (item: T) => string;
  placeholder?: string;
  /** Hide the search input (still scrollable). Default false. */
  noSearch?: boolean;
  /** Item ids to filter out client-side (e.g. already-picked agents). */
  excludeIds?: string[];
  disabled?: boolean;
  className?: string;
  /** Page size for each fetch. Default 20. */
  pageLimit?: number;
  /** Product-only server search. Standard Managed resources do not expose
   *  `q`, so search is client-side unless the endpoint opts in explicitly. */
  searchParam?: "q";
  /** Explicit only for product endpoints that retain cursor/next_cursor. */
  pagination?: PaginationContract;
}

export function Combobox<T>({
  value,
  onValueChange,
  endpoint,
  getValue,
  getLabel,
  getTextLabel,
  placeholder = "Select...",
  noSearch = false,
  excludeIds,
  disabled,
  className,
  pageLimit = 20,
  searchParam,
  pagination = "managed",
}: ComboboxProps<T>) {
  const { api } = useApi();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [debouncedInput, setDebouncedInput] = useState("");

  const listEndRef = useRef<HTMLDivElement>(null);

  // ── Debounce input → debouncedInput ──
  useEffect(() => {
    const t = setTimeout(() => setDebouncedInput(input), 250);
    return () => clearTimeout(t);
  }, [input]);

  // ── Infinite list fetch via TQ ──
  const infiniteQuery = useInfiniteQuery<PageResponse<T>>({
    queryKey: [
      endpoint,
      "combobox",
      searchParam ? debouncedInput : "",
      pageLimit,
      pagination,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api<PageResponse<T>>(
        buildComboboxPageUrl(endpoint, {
          limit: pageLimit,
          page: typeof pageParam === "string" ? pageParam : undefined,
          search: debouncedInput,
          searchParam,
          pagination,
        }),
        { signal },
      ),
    getNextPageParam: (page) => readComboboxNextPage(page, pagination),
    enabled: open,
    placeholderData: keepPreviousData,
  });

  const items = useMemo<T[]>(() => {
    const pages = infiniteQuery.data?.pages ?? [];
    if (pages.length === 0) return [];
    if (pages.length === 1) return pages[0].data;
    return pages.flatMap((p) => p.data);
  }, [infiniteQuery.data]);

  const isFetching = infiniteQuery.isFetching;
  const hasMore = !!infiniteQuery.hasNextPage;

  // ── Resolve preset value's label when it's not in the current items ──
  const presetInItems = !value || items.some((it) => getValue(it) === value);
  const { data: presetFetched } = useApiQuery<T>(
    !presetInItems && value ? `${endpoint}/${value}` : null,
  );
  const presetItem: T | null = presetInItems
    ? items.find((it) => getValue(it) === value) ?? null
    : presetFetched ?? null;

  // ── IntersectionObserver for "scrolled to bottom → load more" ──
  useEffect(() => {
    if (!open || !hasMore || infiniteQuery.isFetchingNextPage) return;
    const sentinel = listEndRef.current;
    if (!sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void infiniteQuery.fetchNextPage();
        }
      },
      { root: sentinel.parentElement, threshold: 0.1 },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [open, hasMore, infiniteQuery]);

  // ── Trigger label ──
  const labelText = (() => {
    if (!value) return placeholder;
    const item = presetItem ?? items.find((it) => getValue(it) === value);
    if (!item) return value; // fallback to raw id while detail resolves
    return getTextLabel ? getTextLabel(item) : String(getValue(item));
  })();
  const isPlaceholder = !value;

  // ── Filter items by excludeIds ──
  const normalizedSearch = debouncedInput.trim().toLocaleLowerCase();
  const searched =
    normalizedSearch && !searchParam
      ? items.filter((it) => {
          const text = getTextLabel
            ? getTextLabel(it)
            : String(getValue(it));
          return text.toLocaleLowerCase().includes(normalizedSearch);
        })
      : items;
  const visible = excludeIds
    ? searched.filter((it) => !excludeIds.includes(getValue(it)))
    : searched;

  const showInitialLoading = items.length === 0 && isFetching;

  const handleSelect = useCallback(
    (id: string, item: T) => {
      onValueChange(id, item);
      setOpen(false);
      setInput("");
    },
    [onValueChange],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost"
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          className={
            className ??
            "w-full inline-flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] disabled:opacity-50 disabled:cursor-not-allowed"
          }
        >
          <span
            className={cn(
              "truncate text-left flex-1",
              isPlaceholder && "text-fg-subtle",
            )}
          >
            {labelText}
          </span>
          <ChevronDownIcon className="size-3.5 text-fg-subtle shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        // Match trigger width so the dropdown lines up with the trigger.
        className="p-0 w-[var(--radix-popover-trigger-width)] min-w-[200px]"
      >
        <Command shouldFilter={false} className="max-h-80">
          {!noSearch && (
            <CommandInput
              value={input}
              onValueChange={setInput}
              placeholder="Search..."
              autoFocus
            />
          )}
          <CommandList>
            {!isFetching && visible.length === 0 && (
              <CommandEmpty>
                {debouncedInput
                  ? `No results for "${debouncedInput}"`
                  : "No results"}
              </CommandEmpty>
            )}
            {visible.map((it) => {
              const v = getValue(it);
              return (
                <CommandItem
                  key={v}
                  value={v}
                  onSelect={() => handleSelect(v, it)}
                  className="cursor-pointer"
                >
                  <span className="truncate flex-1">{getLabel(it)}</span>
                  {value === v && (
                    <CheckIcon className="size-3.5 text-brand" />
                  )}
                </CommandItem>
              );
            })}
            {/* Sentinel for IntersectionObserver — sits inside scroll
                container so its own visibility tracks scroll position. */}
            {hasMore && (
              <div ref={listEndRef} className="py-2 text-center text-sm text-fg-subtle">
                {infiniteQuery.isFetchingNextPage ? "Loading..." : ""}
              </div>
            )}
            {showInitialLoading && (
              <div className="px-3 py-6 text-center text-sm text-fg-subtle">
                Loading...
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
