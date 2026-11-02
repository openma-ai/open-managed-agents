import { Button } from "./ui/button";
import { OpenmaStartupLoader } from "./OpenmaStartupLoader";

export function RouteLoading() {
  return <div className="flex h-screen items-center justify-center bg-bg" role="status" aria-label="Loading page">
    <OpenmaStartupLoader />
  </div>;
}

/** A failed chunk must leave a visible way back, including on direct visits. */
export function RouteLoadError() {
  return <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg px-6 text-center text-fg">
    <h1 className="text-lg font-medium">Couldn’t load this page</h1>
    <p className="text-sm text-fg-muted">Check your connection and reload to try again.</p>
    <Button onClick={() => window.location.reload()}>Reload page</Button>
    <a href="/login" className="text-sm underline">Back to sign in</a>
  </main>;
}
