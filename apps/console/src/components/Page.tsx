import type { ReactNode } from "react";

/**
 * Standard page wrapper. Optional `header` slot renders before the
 * padded content so a sticky `PageHeader` can pin to the top of the
 * scroll context (`<SidebarInset>` → body scroll) without being offset
 * by Page's own padding.
 *
 * Padding is fixed (no responsive scaling) so the left edge stays
 * aligned with the SidebarTrigger icon glyph axis (12 px / `pl-3`) at
 * every viewport. PageHeader owns its own top padding (`pt-3`), so the
 * content area below adds only `pb-4` — no `pt-*` here or the
 * header→content gap would double up.
 *
 * Use for content/detail/list pages. Pages with custom chrome (chat-
 * style shells like SessionDetail) keep their own layout.
 */
interface PageProps {
  children: ReactNode;
  /** Sticky page header — usually a `<PageHeader />`. Rendered before
   *  the padded content area so it can sit flush against the top of the
   *  scroll context. */
  header?: ReactNode;
  className?: string;
}

export function Page({ header, children, className = "" }: PageProps) {
  return (
    <>
      {header}
      <div className={`pl-3 pr-4 pb-4 ${className}`.trim()}>{children}</div>
    </>
  );
}
