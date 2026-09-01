import { createPortToken } from "./index";

export interface HttpClientPort {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export const httpClientPort = createPortToken<HttpClientPort>(
  "platform.http-client",
);

export interface WorkspaceContextPort {
  workspaceId: string;
}

export const workspaceContextPort = createPortToken<WorkspaceContextPort>(
  "application.workspace-context",
);

export interface ClockPort {
  now(): Date;
}

export const clockPort = createPortToken<ClockPort>("platform.clock");

export interface IdGeneratorPort {
  next(namespace: string): string;
}

export const idGeneratorPort = createPortToken<IdGeneratorPort>(
  "platform.id-generator",
);
