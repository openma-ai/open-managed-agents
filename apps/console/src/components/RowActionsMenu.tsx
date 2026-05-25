import { MoreHorizontalIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Per-row action menu — small ⋯ trigger in the last column of every
 * list page. Opens a shadcn DropdownMenu with the supplied items.
 *
 * The trigger stops click propagation so opening the menu on a
 * row-click-navigable list doesn't ALSO navigate to the row's detail
 * page. Same trick for individual item clicks.
 *
 * Per-item `destructive` paints brand-danger text; the menu also
 * inserts a separator before any destructive item so the dangerous
 * choice never sits flush against its safer siblings.
 */
export interface RowAction {
  label: ReactNode;
  /** Optional icon (lucide). Rendered left of the label, size-4. */
  icon?: ReactNode;
  onSelect: () => void;
  /** Paint as danger + add a separator above. */
  destructive?: boolean;
  /** Render the item but greyed-out (e.g. "Archive" on an already-
   *  archived row). The item is still rendered so the menu layout
   *  doesn't shift between rows. */
  disabled?: boolean;
}

interface RowActionsMenuProps {
  actions: RowAction[];
  /** aria-label for the trigger button — pass an entity hint like
   *  "Actions for {row.name}" so screen readers can disambiguate
   *  rows. */
  label?: string;
}

export function RowActionsMenu({ actions, label = "Row actions" }: RowActionsMenuProps) {
  if (actions.length === 0) return null;

  // Insert a separator before the first destructive item if there are
  // safe items above it. Pure render-time decoration, no state.
  const items: Array<RowAction | "separator"> = [];
  let sawSafe = false;
  let sawSeparator = false;
  for (const a of actions) {
    if (a.destructive && sawSafe && !sawSeparator) {
      items.push("separator");
      sawSeparator = true;
    }
    items.push(a);
    if (!a.destructive) sawSafe = true;
  }

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "inline-flex items-center justify-center size-7 rounded-md",
              "text-fg-subtle hover:text-fg hover:bg-bg-surface",
              "transition-colors outline-none",
              "focus-visible:bg-bg-surface",
            )}
          >
            <MoreHorizontalIcon className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          collisionPadding={8}
          // Stop propagation on the content so the row-click handler
          // never fires when the user clicks inside the open menu.
          onClick={(e) => e.stopPropagation()}
          className="w-40"
        >
          {items.map((item, i) => {
            if (item === "separator") return <DropdownMenuSeparator key={`sep-${i}`} />;
            return (
              <DropdownMenuItem
                key={i}
                disabled={item.disabled}
                onSelect={() => item.onSelect()}
                className={cn(
                  item.destructive && "text-danger focus:text-danger focus:bg-danger-subtle",
                )}
              >
                {item.icon}
                {item.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
