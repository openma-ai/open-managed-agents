export type SessionBootstrapContent =
  | { type: "text"; text: string }
  | {
      type: "image";
      source:
        | { type: "base64"; data: string; mediaType: string }
        | { type: "url"; url: string }
        | { type: "file"; fileId: string };
    }
  | {
      type: "document";
      source:
        | { type: "base64"; data: string; mediaType: string }
        | { type: "text"; data: string; mediaType: "text/plain" }
        | { type: "url"; url: string }
        | { type: "file"; fileId: string };
      context?: string | null;
      title?: string | null;
    }
  | { type: "redacted" };

/** Events persisted and delivered before the first Session runtime turn. */
export type SessionBootstrapEvent =
  | { type: "user.message"; content: SessionBootstrapContent[] }
  | {
      type: "user.define_outcome";
      description: string;
      rubric:
        | { type: "text"; content: string }
        | { type: "file"; fileId: string };
      maxIterations?: number | null;
    }
  | { type: "system.message"; content: Array<{ type: "text"; text: string }> };
