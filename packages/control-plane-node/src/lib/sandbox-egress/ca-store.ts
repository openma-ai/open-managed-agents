/** Deployment-wide CA material. Only `cert` may be copied into a sandbox. */
export interface EgressCaMaterial {
  cert: string;
  key: string;
}

/** Platform-neutral durable storage; failures must propagate, never mean absent. */
export interface EgressCaStore {
  load(): Promise<EgressCaMaterial | null>;
  /** Atomically store only if absent. Never overwrite a concurrent winner.
   * A subsequent load must observe the persisted winner. */
  createIfAbsent(material: EgressCaMaterial): Promise<void>;
}
