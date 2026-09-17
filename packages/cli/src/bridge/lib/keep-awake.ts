import { spawn, type ChildProcess } from 'node:child_process';

/** Platform adapter only: no credentials, execution leases or session policy.
 * Every assertion is tied to this process (PID or pipe EOF), including SIGKILL. */
export function keepAwakeCommand(platform: string, pid: number, node: string): { command: string; args: string[] } | null {
  if (platform === 'darwin') return { command: '/usr/bin/caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'linux') return {
    command: 'systemd-inhibit', args: ['--what=idle:sleep', '--who=OpenMA', '--why=OpenMA runner is available for local tasks', '--mode=block',
      node, '-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'],
  };
  if (platform === 'win32') return {
    command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class OpenMAPower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'
if ([OpenMAPower]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'Cannot prevent system idle sleep' }
try { [Console]::In.ReadToEnd() | Out-Null } finally { [OpenMAPower]::SetThreadExecutionState([uint32]2147483648) | Out-Null }
`],
  };
  return null;
}

export function startKeepAwake(options: {
  warn(message: string): void;
  platform?: string;
  spawn?: typeof spawn;
}): () => void {
  const command = keepAwakeCommand(options.platform ?? process.platform, process.pid, process.execPath);
  if (!command) { options.warn('Automatic sleep prevention is unavailable on this platform'); return () => {}; }
  let stopped = false;
  let child: ChildProcess | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const launch = () => {
    if (stopped) return;
    let finished = false;
    const failed = () => {
      if (finished || stopped) return;
      finished = true;
      child = undefined;
      options.warn('Sleep prevention helper unavailable or exited; retrying in 30s. The OS may allow this runner to sleep.');
      retry = setTimeout(launch, 30_000);
      retry.unref();
    };
    try {
      child = (options.spawn ?? spawn)(command.command, command.args, {
        stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
      });
      // The pipe is a lifetime token on Linux/Windows, never a data channel.
      child.stdin?.on('error', () => {});
      child.once('error', failed);
      child.once('exit', failed);
    } catch { failed(); }
  };
  launch();
  return () => {
    if (stopped) return;
    stopped = true;
    if (retry) clearTimeout(retry);
    child?.stdin?.end();
    // Linux inhibitor's child exits on EOF so no orphan retains the lock.
    if ((options.platform ?? process.platform) !== 'linux') child?.kill();
    child = undefined;
  };
}
