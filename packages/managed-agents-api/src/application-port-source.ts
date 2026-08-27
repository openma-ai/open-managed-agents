import type { Context } from "hono";

export type ApplicationPortResolver<Port> = (context: Context) => Port;

export type ApplicationPortSource<Port> =
  | Port
  | ApplicationPortResolver<Port>;

export function resolveApplicationPort<Port>(
  source: ApplicationPortSource<Port>,
  context: Context,
): Port {
  return typeof source === "function"
    ? (source as ApplicationPortResolver<Port>)(context)
    : source;
}
