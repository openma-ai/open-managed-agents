import {it,expect} from 'vitest';
import {mkdtemp,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nodeWorkOutputJournal} from '../src/node-work-output-journal';
it('reopens exact pending bytes, separates generations and clears only after acknowledgement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'oma-work-journal-'));
 try{
  const owner={workId:'w',generation:2,holder:'a',sessionId:'s'};
  const first=nodeWorkOutputJournal(root);expect(await first.read(owner)).toBeNull();
  const body=JSON.stringify({events:[{id:'original-call'}],root:{inputId:'input'}});
  await first.write(owner,body);
  const reopened=nodeWorkOutputJournal(root);
  expect(await reopened.read({sessionId:'s',holder:'a',generation:2,workId:'w'})).toBe(body);
  expect(await reopened.read({...owner,generation:3})).toBeNull();
  expect(await reopened.read({...owner,holder:'b'})).toBeNull();
  const directory=join(root,'.oma','work-output');
  for(const path of await readdir(directory))expect((await stat(join(directory,path))).mode&0o777).toBe(0o600);
  await reopened.write(owner,null);expect(await first.read(owner)).toBeNull();
 }finally{await rm(root,{recursive:true,force:true});}
});
