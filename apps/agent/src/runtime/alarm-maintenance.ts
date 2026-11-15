/** Bounds an alarm's wait on maintenance, not model/tool execution.
 * This does not cancel RPCs; callers retain their singleflight until they settle. */
export async function waitForAlarmMaintenance<T>(work: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Alarm maintenance wait exceeded its budget")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
