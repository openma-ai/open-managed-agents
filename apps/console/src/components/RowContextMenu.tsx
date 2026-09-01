import type { ReactElement, ReactNode } from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

export interface RowAction {
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

interface RowContextMenuProps {
  actions: RowAction[];
  children: ReactElement;
}

/** Context-only row actions. Keeping the trigger on the row itself removes
 * the permanent trailing action column while retaining keyboard ContextMenu
 * / Shift+F10 support from Radix. */
export function RowContextMenu({ actions, children }: RowContextMenuProps) {
  if (actions.length === 0) return children;

  const items: Array<RowAction | "separator"> = [];
  let sawSafe = false;
  let sawSeparator = false;
  for (const action of actions) {
    if (action.destructive && sawSafe && !sawSeparator) {
      items.push("separator");
      sawSeparator = true;
    }
    items.push(action);
    if (!action.destructive) sawSafe = true;
  }

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          className="z-50 min-w-40 overflow-hidden rounded-[var(--console-radius-popover)] border border-[var(--border-chrome)] bg-popover p-1 text-popover-foreground shadow-[var(--shadow-popover)]"
          collisionPadding={8}
        >
          {items.map((item, index) =>
            item === "separator" ? (
              <ContextMenuPrimitive.Separator
                key={`separator-${index}`}
                className="-mx-1 my-1 h-px bg-border"
              />
            ) : (
              <ContextMenuPrimitive.Item
                key={index}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cn(
                  "relative flex h-[var(--menu-action-row-h)] cursor-default select-none items-center gap-2 rounded-[var(--console-radius-md)] px-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
                  item.destructive &&
                    "text-danger data-[highlighted]:bg-danger-subtle data-[highlighted]:text-danger",
                )}
              >
                {item.icon}
                {item.label}
              </ContextMenuPrimitive.Item>
            ),
          )}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
