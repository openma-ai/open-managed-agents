import { useApiQuery } from "../lib/useApiQuery";
import { Select, SelectOption } from "./Select";

/** One entry of GET /v1/oma/sandbox_images. Provider references are never
 * exposed; the Console only ever submits the alias. */
export interface SandboxImageOption {
  alias: string;
  label: string;
  description: string | null;
}

interface SandboxImageListResponse {
  data?: Array<Partial<SandboxImageOption> & { alias?: unknown }>;
}

/** Radix Select reserves the empty string, so "default image" needs a token. */
export const DEFAULT_SANDBOX_IMAGE = "__default__";

/**
 * The operator's sandbox image catalog. A deployment without the endpoint
 * (silent 404) or with an empty catalog yields `[]`, which hides the selector.
 */
export function useSandboxImages(): SandboxImageOption[] {
  const { data } = useApiQuery<SandboxImageListResponse>("/v1/oma/sandbox_images", undefined, {
    staleTime: 5 * 60_000,
    retry: false,
  });
  return (data?.data ?? []).flatMap((item) =>
    typeof item.alias === "string" && item.alias.length > 0
      ? [{
          alias: item.alias,
          label: typeof item.label === "string" && item.label ? item.label : item.alias,
          description: typeof item.description === "string" ? item.description : null,
        }]
      : [],
  );
}

/**
 * Sandbox image dropdown for Environment create/edit. Renders nothing when the
 * catalog is empty. `value` is an alias or DEFAULT_SANDBOX_IMAGE. An alias the
 * catalog no longer lists stays visible so saving does not silently drop it.
 */
export function SandboxImageSelect({
  id,
  images,
  value,
  onValueChange,
}: {
  id?: string;
  images: SandboxImageOption[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  if (images.length === 0 && value === DEFAULT_SANDBOX_IMAGE) return null;
  const selected = images.find((image) => image.alias === value);
  const missing = value !== DEFAULT_SANDBOX_IMAGE && selected === undefined;
  return (
    <div>
      <Select id={id} value={value} onValueChange={onValueChange} placeholder="Sandbox image">
        <SelectOption value={DEFAULT_SANDBOX_IMAGE}>Default image</SelectOption>
        {images.map((image) => (
          <SelectOption key={image.alias} value={image.alias}>{image.label}</SelectOption>
        ))}
        {missing && (
          <SelectOption value={value}>{`${value} (unavailable)`}</SelectOption>
        )}
      </Select>
      <p className="text-xs text-fg-subtle mt-1">
        {missing
          ? "This image is no longer offered by the operator; sessions will fail until you pick another."
          : selected?.description ?? "Pre-built image sandboxes start from. Packages below install on top of it."}
      </p>
    </div>
  );
}

/** Map the form value to the `_oma.sandbox_image` wire value. */
export function sandboxImageWireValue(value: string): string | null {
  return value === DEFAULT_SANDBOX_IMAGE ? null : value;
}
