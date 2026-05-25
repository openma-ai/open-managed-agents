import { CheckIcon } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

/**
 * Faceted filter — single-select variant of shadcn's tasks/data-table
 * recipe (their canonical version is multi-select; ours is single
 * because every current application — agent status, model card
 * provider, etc. — is a mutually-exclusive server-side param).
 *
 * Built on cmdk Command so the popover always gives type-ahead search,
 * even when the option list is short. Visual recipe mirrors the
 * official example: a small square indicator that fills with the brand
 * color when the row is selected, label to its right.
 *
 * Designed to be dropped inside a shadcn `<PopoverContent>` from the
 * caller (so the caller owns the trigger / chip / outer chrome and we
 * only own the filter UI). PopoverContent should set `className="p-0"`
 * so cmdk's own padding controls the spacing.
 */
export interface FacetedFilterOption {
  value: string;
  label: string;
}

interface FacetedFilterProps {
  options: FacetedFilterOption[];
  value: string;
  onValueChange: (value: string) => void;
  searchPlaceholder?: string;
}

export function FacetedFilter({
  options,
  value,
  onValueChange,
  searchPlaceholder = "Search...",
}: FacetedFilterProps) {
  return (
    <Command>
      <CommandInput placeholder={searchPlaceholder} />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        <CommandGroup>
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <CommandItem
                key={opt.value}
                value={opt.label}
                onSelect={() => onValueChange(opt.value)}
              >
                <div
                  className={cn(
                    "mr-2 flex size-4 items-center justify-center rounded-sm border",
                    selected
                      ? "bg-brand border-brand text-bg"
                      : "border-border opacity-50 [&_svg]:invisible",
                  )}
                >
                  <CheckIcon className="size-3.5" />
                </div>
                <span>{opt.label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
