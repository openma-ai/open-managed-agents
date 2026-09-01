import type {
  DreamExecutionApplicationPort,
  DreamExecutionSchedulerPort,
  ScheduleDreamExecution,
  ScheduleDreamExecutionResult,
} from "@open-managed-agents/managed-agents-application";
import {
  bindPort,
  defineAppModule,
  type AppModule,
} from "@open-managed-agents/app";
import { workspaceContextPort } from "@open-managed-agents/app/capabilities";
import {
  dreamExecutionPort,
  dreamExecutionSchedulerPort,
} from "@open-managed-agents/app/modules/dreams";

export interface InProcessDreamExecutionSchedulerDependencies {
  workspaceId: string;
  execution: DreamExecutionApplicationPort;
  defer(task: Promise<void>): void;
  onError?(error: Error): void;
}

export class InProcessDreamExecutionScheduler
  implements DreamExecutionSchedulerPort
{
  constructor(
    private readonly dependencies: InProcessDreamExecutionSchedulerDependencies,
  ) {}

  async schedule(
    input: ScheduleDreamExecution,
  ): Promise<ScheduleDreamExecutionResult> {
    if (input.workspaceId !== this.dependencies.workspaceId) {
      return { type: "rejected", message: "Dream workspace scope mismatch" };
    }
    let release: (scheduled: boolean) => void = () => undefined;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const task = gate
      .then(async (scheduled) => {
        if (!scheduled) return;
        await this.dependencies.execution.executeDream({
          dreamId: input.dream.id,
        });
      })
      .catch((error: unknown) => {
        this.dependencies.onError?.(
          error instanceof Error ? error : new Error("Dream execution failed"),
        );
      });
    try {
      this.dependencies.defer(task);
      release(true);
      return { type: "scheduled" };
    } catch (error) {
      release(false);
      return {
        type: "rejected",
        message: error instanceof Error
          ? error.message
          : "Dream execution could not be deferred",
      };
    }
  }
}

export type InProcessDreamExecutionSchedulerModuleOptions = Pick<
  InProcessDreamExecutionSchedulerDependencies,
  "defer" | "onError"
>;

export function inProcessDreamExecutionSchedulerModule(
  options: InProcessDreamExecutionSchedulerModuleOptions,
): AppModule {
  return defineAppModule({
    name: "managed-agents:in-process-dream-execution-scheduler",
    provides: [dreamExecutionSchedulerPort],
    requires: [workspaceContextPort, dreamExecutionPort],
    setup({ port }) {
      return {
        ports: [bindPort(
          dreamExecutionSchedulerPort,
          new InProcessDreamExecutionScheduler({
            workspaceId: port(workspaceContextPort).workspaceId,
            execution: port(dreamExecutionPort),
            defer: options.defer,
            ...(options.onError !== undefined && {
              onError: options.onError,
            }),
          }),
        )],
      };
    },
  });
}
