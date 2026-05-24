import type { ReactNode } from "react";

/**
 * Standard page wrapper. Optional `header` slot renders before the
 * padded content so a sticky `PageHeader` can pin to the top of the
 * scroll context (`<SidebarInset>` → body scroll) without being offset
 * by Page's own padding.
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
      <div className={`py-4 md:py-8 lg:py-10 ${className}`.trim()}>
        {header ? children : <div className="px-4 md:px-8 lg:px-10">{children}</div>}
      </div>
    </>
  );
}
