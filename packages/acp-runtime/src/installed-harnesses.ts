/** Image/deployment-owned inventory, not a Session or Work selection.
 * Pure validation: safe in workerd/browser, no Node or registry/network IO. */
export interface InstalledAcpHarness {
  id: string;
  version: string;
  command: string;
  args?: string[];
}
const pinnedVersion = /^[0-9]+(?:\.[0-9]+)*(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const identity = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const absoluteCommand = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/;
const invalid = () => new TypeError("OPENMA_ACP_HARNESSES entries require id, pinned version, absolute command and optional string args");

export function parseInstalledHarnesses(raw: string | undefined): InstalledAcpHarness[] | null {
  if (raw === undefined) return null;
  let entries: unknown;
  try { entries = JSON.parse(raw); }
  catch { throw new TypeError("OPENMA_ACP_HARNESSES must be a JSON array"); }
  if (!Array.isArray(entries)) throw new TypeError("OPENMA_ACP_HARNESSES must be a JSON array");
  const seen = new Set<string>();
  return entries.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const {id,version,command,args} = entry as Record<string,unknown>;
    if (typeof id !== "string" || !identity.test(id)
      || typeof version !== "string" || !pinnedVersion.test(version)
      || typeof command !== "string" || !absoluteCommand.test(command)
      || command.split("/").some(part => part === "." || part === "..")
      || (args !== undefined && (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))))) throw invalid();
    const key = JSON.stringify([id,version]);
    if (seen.has(key)) throw new TypeError("OPENMA_ACP_HARNESSES contains a duplicate identity");
    seen.add(key);
    return {id,version,command,...(args === undefined ? {} : {args:[...(args as string[])]})};
  });
}
