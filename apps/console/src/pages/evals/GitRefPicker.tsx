import { useEffect, useState } from "react";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { EvalGitRefList } from "@open-managed-agents/api-types";
import { useI18n } from "../../i18n";
import { useApiQuery } from "../../lib/useApiQuery";
import { describeError } from "./shared";

/** Repositories GET /v1/oma/evals/git-refs can list. */
const LISTABLE = /^https:\/\/(github\.com|huggingface\.co)\/[^/\s]+\/[^\s]+/u;

interface GitRefPickerProps {
  /** Set by <Field> so the label names the trigger. */
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** Repository URL as typed; refs are fetched once it looks listable. */
  url: string;
  /** Chosen ref; "" means fallbackRef (or the default branch when unset). */
  value: string;
  onChange: (ref: string) => void;
  /** What an empty value resolves to server-side (sync: the current ref). */
  fallbackRef?: string;
}

/** Pick a branch or tag of a git repository, or type any ref / commit sha. */
export function GitRefPicker({ url, value, onChange, fallbackRef, ...aria }: GitRefPickerProps) {
  const { t } = useI18n();
  const m = t.evals;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedUrl, setDebouncedUrl] = useState(url.trim());
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedUrl(url.trim()), 400);
    return () => clearTimeout(timer);
  }, [url]);

  const listable = LISTABLE.test(debouncedUrl);
  const query = useApiQuery<EvalGitRefList>(
    listable ? "/v1/oma/evals/git-refs" : null,
    listable ? { url: debouncedUrl } : undefined,
    { retry: false, staleTime: 60_000 },
  );
  const refs = query.isPlaceholderData ? undefined : query.data;
  const loading = listable && (query.isFetching || query.isPlaceholderData) && !query.error;
  const defaultBranch = refs?.default_branch ?? null;
  const effective = value || fallbackRef || defaultBranch || "";

  const triggerLabel = value
    ? value
    : fallbackRef
      ? fallbackRef
      : defaultBranch
        ? m.gitRefDefaultBranch.replace("{branch}", defaultBranch)
        : m.gitRefDefault;

  const typed = search.trim();
  const known = !!refs && [...refs.branches, ...refs.tags].some((ref) => ref.name === typed);

  const pick = (ref: string) => {
    onChange(ref);
    setOpen(false);
    setSearch("");
  };

  const row = (kind: "branch" | "tag", ref: { name: string; commit: string }) => (
    <CommandItem
      key={`${kind}:${ref.name}`}
      value={`${kind}:${ref.name}`}
      keywords={[ref.name, ref.commit]}
      data-checked={effective === ref.name}
      onSelect={() => pick(ref.name)}
      className="cursor-pointer"
    >
      <span className="min-w-0 flex-1 truncate">
        {ref.name}
        {kind === "branch" && ref.name === defaultBranch && (
          <span className="ml-1.5 rounded bg-bg-surface px-1.5 text-xs text-fg-muted">{m.gitRefDefaultBadge}</span>
        )}
      </span>
      <span className="shrink-0 font-mono text-xs text-fg-subtle">{ref.commit.slice(0, 7)}</span>
    </CommandItem>
  );

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSearch(""); }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          {...aria}
          className="w-full inline-flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand"
        >
          <span className={cn("truncate text-left flex-1", !value && "text-fg-subtle")}>{triggerLabel}</span>
          <ChevronDownIcon className="size-3.5 text-fg-subtle shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-[var(--radix-popover-trigger-width)] min-w-[260px]">
        <Command className="max-h-80">
          <CommandInput value={search} onValueChange={setSearch} placeholder={m.gitRefSearch} autoFocus />
          <CommandList>
            {typed && !known && (
              <CommandGroup forceMount>
                <CommandItem forceMount value={`use:${typed}`} onSelect={() => pick(typed)} className="cursor-pointer">
                  <span className="truncate">{m.gitRefUse.replace("{ref}", typed)}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {!listable && <p className="px-3 py-4 text-center text-sm text-fg-subtle">{m.gitRefNeedUrl}</p>}
            {loading && <p className="px-3 py-4 text-center text-sm text-fg-subtle">{m.gitRefLoading}</p>}
            {listable && query.error && (
              <p role="alert" className="px-3 py-3 text-sm text-danger whitespace-pre-wrap">{describeError(t, query.error)}</p>
            )}
            {refs && (
              <>
                {!typed && <CommandEmpty>{m.gitRefNone}</CommandEmpty>}
                {refs.branches.length > 0 && (
                  <CommandGroup heading={m.gitRefBranches}>{refs.branches.map((ref) => row("branch", ref))}</CommandGroup>
                )}
                {refs.tags.length > 0 && (
                  <CommandGroup heading={m.gitRefTags}>{refs.tags.map((ref) => row("tag", ref))}</CommandGroup>
                )}
                {refs.truncated && <p className="px-3 py-2 text-xs text-fg-subtle">{m.gitRefTruncated}</p>}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
