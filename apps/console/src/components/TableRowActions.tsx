import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { RowAction } from "./RowContextMenu";

/** Visible per-row menu for the Actions column; the same actions are also
 *  on the row's context menu. */
export function RowActionsMenu({ label, actions }: { label: string; actions: RowAction[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label}>
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      {/* React bubbles portal clicks to the row, which would open the detail page. */}
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {actions.map((action, index) => (
          <ActionItem key={index} action={action} separate={Boolean(action.destructive) && index > 0} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionItem({ action, separate }: { action: RowAction; separate: boolean }) {
  return (
    <>
      {separate && <DropdownMenuSeparator />}
      <DropdownMenuItem
        disabled={action.disabled}
        variant={action.destructive ? "destructive" : "default"}
        onSelect={action.onSelect}
      >
        {action.icon}
        {action.label}
      </DropdownMenuItem>
    </>
  );
}
