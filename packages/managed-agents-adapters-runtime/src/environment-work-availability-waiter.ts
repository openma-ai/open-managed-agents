import type {
  EnvironmentWorkAvailabilityWaiterPort,
  WaitForEnvironmentWorkAvailability,
} from "@open-managed-agents/managed-agents-application";

type Delay = (milliseconds: number) => Promise<void>;

const delay: Delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class TimerEnvironmentWorkAvailabilityWaiter
  implements EnvironmentWorkAvailabilityWaiterPort
{
  constructor(private readonly waitForDelay: Delay = delay) {}

  async wait(input: WaitForEnvironmentWorkAvailability): Promise<void> {
    if (
      !Number.isInteger(input.maximumWaitMilliseconds) ||
      input.maximumWaitMilliseconds < 0
    ) {
      throw new Error("Environment Work wait duration must be a non-negative integer");
    }
    await this.waitForDelay(input.maximumWaitMilliseconds);
  }
}
