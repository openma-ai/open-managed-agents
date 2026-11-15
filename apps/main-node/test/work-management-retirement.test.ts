import { afterEach, expect, it, vi } from "vitest";
import { callManagementRpc, type ManagementRpcState } from "../../../packages/control-plane-node/src/lib/work-management-rpc";
import { retireManagementProcess, type ManagementRetirementState } from "../../../packages/control-plane-node/src/lib/work-management-retirement";
afterEach(() => vi.useRealTimers());
function fixture() {
  const state: ManagementRpcState & ManagementRetirementState = {
    current: vi.fn(async () => false),
    handle: { id: "exact-process", pid: 42, kill: vi.fn(async () => {}), getStatus: vi.fn(async () => "exited") },
  };
  const retire = () => retireManagementProcess(state, (op, action) => callManagementRpc(state, op, action));
  return { state, retire };
}
it("consumes a late acknowledged kill and late terminal status without repeating either native call", async () => {
  vi.useFakeTimers(); const { state, retire } = fixture();
  vi.mocked(state.handle.kill).mockImplementation(() => new Promise(resolve => setTimeout(resolve, 3046)));
  vi.mocked(state.handle.getStatus).mockImplementation(() => new Promise(resolve => setTimeout(() => resolve("exited"), 1500)));
  let wait = expect(retire()).rejects.toThrow("native outcome is unknown");
  await vi.advanceTimersByTimeAsync(1000); await wait;
  await expect(retire()).rejects.toThrow("Previous management RPC outcome is pending");
  expect(state.pending?.op).toBe("kill");
  await vi.advanceTimersByTimeAsync(2046);
  wait = expect(retire()).rejects.toThrow("native outcome is unknown");
  await vi.advanceTimersByTimeAsync(1000); await wait;
  expect(state.handle.kill).toHaveBeenCalledTimes(1);
  expect(state.handle.getStatus).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500);
  await expect(retire()).resolves.toBeUndefined();
  expect(state.handle.kill).toHaveBeenCalledTimes(1); expect(state.handle.getStatus).toHaveBeenCalledTimes(1);
});
it("an acknowledged kill alone never proves exit; running status is checked again", async () => {
  vi.useFakeTimers(); const { state, retire } = fixture();
  vi.mocked(state.handle.getStatus).mockResolvedValue("running");
  const rejected = expect(retire()).rejects.toThrow("exit is unconfirmed");
  await vi.advanceTimersByTimeAsync(200); await rejected;
  expect(state.handle.getStatus).toHaveBeenCalledTimes(5);
  vi.mocked(state.handle.getStatus).mockResolvedValue("exited");
  await retire(); expect(state.handle.getStatus).toHaveBeenCalledTimes(6); expect(state.handle.kill).toHaveBeenCalledTimes(1);
});
it("rechecks authority and propagates an unknown authority even after cleanup completes", async () => {
  const { state, retire } = fixture(); await retire();
  vi.mocked(state.current).mockResolvedValue(true);
  await expect(retire()).rejects.toThrow("still current");
  const failure = new Error("authority unavailable"); vi.mocked(state.current).mockRejectedValue(failure);
  await expect(retire()).rejects.toBe(failure);
  expect(state.handle.kill).toHaveBeenCalledTimes(1);
});
it("failed kill or status does not manufacture a completion receipt", async () => {
  const { state, retire } = fixture(); const failure = new Error("native failure");
  vi.mocked(state.handle.kill).mockRejectedValueOnce(failure);
  await expect(retire()).rejects.toBe(failure);
  vi.mocked(state.handle.getStatus).mockRejectedValueOnce(failure);
  await expect(retire()).rejects.toBe(failure);
  await retire(); expect(state.handle.kill).toHaveBeenCalledTimes(2); expect(state.handle.getStatus).toHaveBeenCalledTimes(2);
});
