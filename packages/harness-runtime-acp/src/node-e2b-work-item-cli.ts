import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import { createNodeManagedAcpSupervisorApp } from "./node-supervisor.js";
import { createNodeManagedAcpWorkItemRunner } from "./node-work-item.js";
import { assertE2BInstalledHarness, createE2BStateIo, loadE2BAgentSpawner } from "./node-e2b-work-item.js";

// Load isolation BEFORE any Work ACK or agent launch. No generic-spawner fallback.
assertE2BInstalledHarness(process.env);
const spawner = await loadE2BAgentSpawner();
const acpRuntime = createAcpRuntime({ type: "local", spawner });
const supervisorApp = createNodeManagedAcpSupervisorApp({ acpRuntime, stateIo: createE2BStateIo(spawner) });
await createNodeManagedAcpWorkItemRunner({ supervisorApp }).run();
