import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

interface ModernLoginShellProps {
  children: ReactNode;
  className?: string;
}

/**
 * Presentation-only auth shell. The page owns state and provider calls while
 * this component keeps every auth mode on one stable, centered track.
 */
export function ModernLoginShell({ children, className }: ModernLoginShellProps) {
  return (
    <main
      data-login-layout="centered"
      className="flex h-full min-h-full w-full overflow-y-auto bg-bg"
    >
      <section
        aria-label="Account access"
        className="flex min-h-full w-full items-center justify-center px-6 py-12 sm:px-8"
      >
        <Card
          className={cn(
            "w-full max-w-[360px] gap-0 border-0 bg-transparent shadow-none",
            className,
          )}
        >
          <CardContent className="p-0">{children}</CardContent>
        </Card>
      </section>
    </main>
  );
}
