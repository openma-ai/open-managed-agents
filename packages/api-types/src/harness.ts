/** Where the registered implementation runs its agent loop, not where its tools run.
 * `host` is the current control-plane process (which may itself be cloud-hosted).
 * `runtime` is an attached runtime; `unknown` is a legacy registration without metadata.
 * These describe existing implementations, not new Agent execution settings. */
export type HarnessExecutionPlacement = "host" | "sandbox" | "runtime" | "unknown";

/** Public, non-secret metadata supplied by deployment composition code. */
export interface HarnessDescriptor {
  id: string;
  label: string;
  description: string;
  execution: { placement: HarnessExecutionPlacement };
  capabilities: {
    /** Can this implementation consume an Agent's runtime_binding? Independent
     * of loop placement; null means undeclared. Informational, not validation
     * or a prohibition on runtime calls through other tools/MCP servers. */
    runtime_binding: boolean | null;
  };
  /** Public Agent configuration paths required by this implementation, not values.
   * `a.b|c.d` means one of the alternatives must be set. */
  requirements: string[];
}

export interface HarnessCatalog {
  object: "list";
  data: HarnessDescriptor[];
  /** `default` is an alias to a registered implementation. A legacy factory
   * registered literally as `default` resolves to itself. null means unset. */
  default_harness_id: string | null;
}
