import {mkdir,open,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

/** Private delivery journal, not canonical history or permission to execute.
 * One serial Work publisher owns one file per exact generation/holder. Only
 * host acknowledgement clears it. Recovery retransmits bytes, never tools.
 * Persistence errors fail closed before the publication request. */
export function nodeWorkOutputJournal(workspacePath:string) {
 const directory=join(workspacePath,'.oma','work-output');
 const identity=(owner:object)=>JSON.stringify(Object.fromEntries(Object.entries(owner).sort(([a],[b])=>a.localeCompare(b))));
 function path(owner:object){return join(directory,createHash('sha256').update(identity(owner)).digest('hex')+'.json');}
 async function write(owner:object,body:string|null){
  await mkdir(directory,{recursive:true,mode:0o700});
  const target=path(owner),temporary=target+'.'+randomUUID()+'.tmp';
  const file=await open(temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify({version:1,owner,body}));await file.sync();}finally{await file.close();}
  await rename(temporary,target);
  const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}
 }
 return {
  async read(owner:object):Promise<string|null>{
   let raw:string;try{raw=await readFile(path(owner),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
   const record=JSON.parse(raw);if(record.version!==1||identity(record.owner)!==identity(owner)||(record.body!==null&&typeof record.body!=='string'))throw Error('Invalid Work output journal');
   return record.body;
  },
  write,
 };
}
