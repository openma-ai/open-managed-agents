import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { startKeepAwake, keepAwakeCommand } from '../src/bridge/lib/keep-awake.js';

class Helper extends EventEmitter {
  ended = false;
  killed = false;
  stdin = { end: () => { this.ended = true; }, on: () => {} };
  kill() { this.killed = true; return true; }
}

describe('daemon keep awake', () => {
  it('pins macOS idle sleep assertion to the owner process without keeping the display on', () => {
    expect(keepAwakeCommand('darwin', 123, '/node')).toEqual({ command: '/usr/bin/caffeinate', args: ['-i', '-w', '123'] });
  });
  it('releases the helper on shutdown and ignores its late failure', () => {
    vi.useFakeTimers();
    const children: Helper[] = [];
    const warnings: string[] = [];
    const stop = startKeepAwake({ platform: 'darwin', warn: m => warnings.push(m), spawn: (() => {
      const child = new Helper(); children.push(child); return child;
    }) as any });
    expect(children).toHaveLength(1);
    stop(); stop();
    expect(children[0]!.killed).toBe(true);
    children[0]!.emit('exit', 1); vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    vi.useRealTimers();
  });
  it('retries a failed OS helper with bounded frequency, cancelling retries on shutdown', () => {
    vi.useFakeTimers();
    const children: Helper[] = [];
    const warnings: string[] = [];
    const stop = startKeepAwake({ platform: 'linux', warn: m => warnings.push(m), spawn: (() => {
      const child = new Helper(); children.push(child); return child;
    }) as any });
    children[0]!.emit('error', new Error('not installed')); children[0]!.emit('exit', 1);
    expect(warnings).toHaveLength(1);
    vi.advanceTimersByTime(29_999); expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(children).toHaveLength(2);
    children[1]!.emit('exit', 1); stop(); vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(2);
    vi.useRealTimers();
  });
});

it.skipIf(process.platform !== 'darwin')('acquires and releases an actual macOS idle-sleep assertion', async () => {
  let helper: ChildProcess | undefined;
  const warnings: string[] = [];
  const stop = startKeepAwake({ warn: message => warnings.push(message), spawn: ((command: string, args: string[], options: any) => {
    helper = spawn(command, args, options); return helper;
  }) as typeof spawn });
  const held = () => execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' })
    .split('\n').some(line => line.includes(`pid ${helper?.pid}(`) && line.includes('PreventUserIdleSystemSleep'));
  try {
    await vi.waitFor(() => expect(held()).toBe(true));
    expect(warnings).toEqual([]);
  } finally { stop(); }
  await vi.waitFor(() => expect(held()).toBe(false));
});

it('Linux lifetime child exits on pipe EOF, including when the owner crashes', async () => {
  const command = keepAwakeCommand('linux', 1, process.execPath)!;
  const script = command.args.at(-1)!;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  try {
    child.stdin!.end();
    expect(await exited).toBe(0);
  } finally { child.kill(); }
});
