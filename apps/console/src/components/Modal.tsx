import { type JSX, type ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// Tailwind JIT safelist hint — these literal `!max-w-*` strings exist
// here so the bundler picks them up; the Modal component picks one of
// them at runtime via `${"!"}${maxWidth}`. shadcn's <DialogContent>
// bakes `sm:max-w-sm` (24rem) into its base className which would
// otherwise cap every modal at 384 px on desktop; the `!` prefix lifts
// our chosen width over it. Add new entries here if a caller starts
// passing a wider value.
//
// !max-w-sm !max-w-md !max-w-lg !max-w-xl !max-w-2xl !max-w-3xl !max-w-4xl

/**
 * Project-level modal convention built on shadcn `Dialog` primitives.
 * Keeps a small controlled API (open/onClose/title/subtitle/maxWidth/
 * children/footer) because the same modal pattern recurs across 18+
 * call sites and each direct `<Dialog>…<DialogContent><DialogHeader>…`
 * expansion would add the same boilerplate. Internals delegate to
 * shadcn so theming, close button (lucide X via DialogContent's
 * showCloseButton default), focus trap, and animations stay aligned
 * with the rest of the design system.
 *
 * Footer is rendered into `DialogFooter` only when provided so unused
 * modals don't get an empty bordered band at the bottom.
 *
 * The children block is wrapped in a scroll container so long forms
 * stay reachable when content exceeds the modal's max height. shadcn's
 * `DialogContent` doesn't auto-scroll; pulling it out of the dialog
 * shell keeps the header sticky and the footer pinned.
 */
interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Tailwind max-width class WITHOUT the `!` prefix (e.g. `max-w-lg`,
   *  `max-w-2xl`). Modal applies `!important` internally to beat
   *  shadcn's baked-in `sm:max-w-sm` cap. Default: `max-w-lg`. */
  maxWidth?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  maxWidth = "max-w-lg",
  children,
  footer,
}: ModalProps): JSX.Element {
  // Strip a stray `!` prefix from caller for back-compat, then apply
  // our own — guarantees exactly one `!` is present in the final class.
  const widthClass = `!${maxWidth.replace(/^!/, "")}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className={cn(
          "max-h-[85vh] flex flex-col gap-0 p-0",
          widthClass,
        )}
      >
        <DialogHeader className="px-6 py-4 border-b border-border gap-1">
          <DialogTitle className="text-lg font-semibold font-display truncate">
            {title}
          </DialogTitle>
          {subtitle && (
            <DialogDescription className="text-sm text-fg-muted">
              {subtitle}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>

        {footer && (
          <DialogFooter className="m-0 px-6 py-4 border-t border-border bg-transparent rounded-none sm:justify-end gap-3">
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
