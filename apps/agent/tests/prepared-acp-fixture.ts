import type { PreparedEnvironmentAcp } from "@open-managed-agents/acp-runtime/environment-setup";
export function preparedAcpFixture(id: string, version: string): PreparedEnvironmentAcp {
 const command = `/home/oma-worker/.oma/installed-agent/${id}/${version}/acp-launch.sh`;
 return { harness: {id,version}, inventory: JSON.stringify([{id,version,command}]), launch: {command} };
}
