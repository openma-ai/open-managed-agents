import { useState, type ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRightIcon } from "lucide-react";

/**
 * Collapsible section with chevron indicator and aria-expanded wiring.
 *
 * Built on shadcn `Collapsible` (which wraps Radix), so Escape support,
 * aria-controls / aria-expanded linkage, and the unmount-after-close
 * animation come for free. Spring-out chevron rotation is added here
 * because shadcn's primitive ships unstyled.
 *
 * Two trigger variants:
 *   - default ("border")  → bordered row with title left + chevron right
 *   - "bare"              → no border, used inside list rows / cards
 *                           where the parent already provides chrome
 */
interface DisclosureProps {
  title: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: "border" | "bare";
  className?: string;
  children: ReactNode;
}

export function Disclosure({
  title,
  meta,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  variant = "border",
  className = "",
  children,
}: DisclosureProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  const wrapperCls = variant === "border" ? "border border-border rounded-md" : "";

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={`${wrapperCls} ${className}`.trim()}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center gap-2 px-3 py-2.5 min-h-11 sm:min-h-0 text-left"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={`size-4 text-fg-muted transition-transform duration-[var(--dur-base)] ease-[var(--ease-soft)] ${
              open ? "rotate-90" : ""
            }`}
          />
          <span className="text-sm font-medium text-fg flex-1 min-w-0">{title}</span>
          {meta && <span className="text-xs text-fg-muted shrink-0">{meta}</span>}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content overflow-hidden">
        <div className="px-3 pb-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
