const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** rclone --daemon starts RC in both parent and child; a fixed Unix socket
 * collides. Start one detached process and acknowledge only a live FUSE mount.
 * The caller creates control as root-only and supplies credentials via env. */
export function e2bNativeMountCommand(command: string, target: string, control: string): string {
  return `nohup ${command} </dev/null >${quote(control + '/mount.log')} 2>&1 &\n` +
    `mount_pid=$!\nfor attempt in $(seq 1 500); do\n` +
    `  kill -0 "$mount_pid" 2>/dev/null || { echo 'native mount process exited; inspect root-only mount.log' >&2; exit 90; }\n` +
    `  if mountpoint -q ${quote(target)}; then exit 0; fi\n  sleep 0.1\ndone\n` +
    `kill "$mount_pid" 2>/dev/null || true\necho 'native mount did not become ready' >&2\nexit 90`;
}
