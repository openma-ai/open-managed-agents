export interface WaitForEnvironmentWorkAvailability {
  workspaceId: string;
  environmentId: string;
  maximumWaitMilliseconds: number;
}

export interface EnvironmentWorkAvailabilityWaiterPort {
  wait(input: WaitForEnvironmentWorkAvailability): Promise<void>;
}
