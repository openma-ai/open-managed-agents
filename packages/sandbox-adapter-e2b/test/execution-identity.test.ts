import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { executionIdentity } from '../src/execution-identity';

it('resolves the real ordinary process identity without requesting root or session credentials', async () => {
  const actual = await executionIdentity({run: async (command, options) => {
    expect(options).toEqual({sessionEnv:false});
    const {stdout}=await promisify(execFile)('/bin/sh',['-c',command]);
    return {stdout,exitCode:0};
  }});
  expect(actual).toEqual({uid:String(process.getuid!()),gid:String(process.getgid!())});
});
it.each(['', '1002', '1002;evil\n1003', '1002\n1003\n0'])('rejects unusable identity %j before privileged setup', async stdout => {
  await expect(executionIdentity({run:async()=>({stdout,exitCode:0})})).rejects.toThrow('Cannot resolve');
});
it('does not accept output from a failed identity command',async()=>{
  await expect(executionIdentity({run:async()=>({stdout:'1002\n1003\n',exitCode:1})})).rejects.toThrow('Cannot resolve');
});
it('preserves a primary GID distinct from the UID',async()=>{
  expect(await executionIdentity({run:async()=>({stdout:'1002\n1003\n',exitCode:0})})).toEqual({uid:'1002',gid:'1003'});
});
