/** One scheduling/placement decision for admission, outbox and bootstrap.
 * Provider/environment labels do not change the Agent's actual placement. */
export function harnessExecutionPlacement(harness:string|null|undefined) {
  return harness === "acp-sandbox" ? "in_sandbox" : "outside_sandbox";
}

export function sessionExecutionPlacement(environment:{config:{type:string}}, session?:{agent:{openma?:{harness?:string|null}|null}}) {
  const placement=harnessExecutionPlacement(session?.agent.openma?.harness);
  return {
    authority:environment.config.type==="self_hosted"||placement==="in_sandbox"?"environment_work":"session_execution",
    harnessPlacement:placement,
    sandboxTokenScope:placement==="in_sandbox"?"all":"egress",
  } as const;
}
