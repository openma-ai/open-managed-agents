import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Native button semantics without inheriting action-button geometry or hover. */
export function Switch({ checked, onCheckedChange, className, ...props }: Omit<ComponentProps<"button">, "onChange"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return <button
    {...props}
    type="button"
    role="switch"
    aria-checked={checked}
    className={cn("console-switch focus-visible:border-fg-muted focus-visible:ring-1 focus-visible:ring-fg/10", className)}
    onClick={() => onCheckedChange(!checked)}
  ><span className="console-switch-thumb" /></button>;
}
