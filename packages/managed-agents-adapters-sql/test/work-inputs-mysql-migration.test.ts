import { expect, it } from "vitest";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { ensureMysqlWorkInputsSchema } from "../src/work-inputs";

// Catalog/DDL contract, NOT a MySQL server. Stores definitions from actual DDL
// so a duplicate contender must verify what the winning migration installed.
function fixture(options: { wrongColumn?: boolean; wrongIndex?: boolean; functionalKey?: boolean; ddlError?: Error; tempTableError?: Error; lockAcquired?: number } = {}) {
 const columns=new Map<string,object>(),indexes=new Map<string,object>();let duplicates=0;let probeAlterCount=0;let lockHeld=false;let lockReleased=0;
 const sql:SqlClient={rowLockTransactions:{
  capability:async()=>({supported:true,engine:'fixture',version:'fixture',reason:'contract only'}),
  run:async body=>{
   let expression='';
   return body({prepare:text=>({bind(){return this;},all:async()=>({results:[]}),first:async()=>{
    if(text.includes('GET_LOCK')){
     const acquired=options.lockAcquired??1;
     if(acquired===1)lockHeld=true;
     return {acquired} as never;
    }
    if(text.includes('RELEASE_LOCK')){
     if(lockHeld){lockHeld=false;lockReleased++;}
     return {released:1} as never;
    }
    return {'Create Table':'CREATE TABLE `oma_work_input_definition_probe` (\n  `candidate` bigint GENERATED ALWAYS AS ('+expression+') STORED\n)'} as never;
   },run:async()=>{
    if(text.startsWith('CREATE TEMPORARY')){
     if(options.tempTableError)throw options.tempTableError;
     expression=/GENERATED ALWAYS AS \(([\s\S]+)\) STORED\)$/.exec(text)![1];
    }else if(text.startsWith('CREATE TABLE IF NOT EXISTS oma_work_input_definition_probe')){
     expression=/GENERATED ALWAYS AS \(([\s\S]+)\) STORED\) ENGINE=InnoDB$/.exec(text)![1];
    }else if(text.startsWith('ALTER TABLE oma_work_input_definition_probe MODIFY candidate')){
     probeAlterCount++;
     expression=/GENERATED ALWAYS AS \(([\s\S]+)\) STORED$/.exec(text)![1];
    }
    return {meta:{changes:0}};
   }})});
  },
 },prepare:text=>{let args:unknown[]=[];return {bind(...values:unknown[]){args=values;return this;},
  first:async()=> (text.includes("SELECT data_type AS kind")?{kind:"varchar",size:191}:text.includes("information_schema.columns")?columns.get(args.join("."))??null:text.includes("information_schema.statistics")?(() => {const value=indexes.get(args.join("."));return value && options.functionalKey && text.includes("COALESCE(column_name") ? {...value,columns:(value as {columns:string}).columns+",<expression>"} : value??null;})():null) as never,
  all:async()=>({results:[]}),run:async()=>({meta:{changes:0}})};},batch:async()=>[],exec:async text=>{
   if(options.ddlError)throw options.ddlError;
   const column=/ALTER TABLE (\w+) ADD COLUMN (\w+) (\w+) GENERATED ALWAYS AS \(([\s\S]+)\) STORED/.exec(text);
   if(column){const key=column[1]+"."+column[2];if(columns.has(key)){duplicates++;throw Object.assign(Error("duplicate column"),{code:"ER_DUP_FIELDNAME",errno:1060});}
    columns.set(key,{expression:options.wrongColumn?"0":column[4],data_type:column[3].toLowerCase(),extra:"STORED GENERATED"});return;}
   const index=/CREATE (UNIQUE )?INDEX (\w+) ON (\w+) \(([^)]+)\)/.exec(text);
   if(index){const key=index[3]+"."+index[2];if(indexes.has(key)){duplicates++;throw Object.assign(Error("duplicate index"),{code:"ER_DUP_KEYNAME",errno:1061});}
    indexes.set(key,{columns:options.wrongIndex?"session_id":index[4],non_unique:index[1]?0:1,index_type:"BTREE",prefixes:0});return;}
   throw Error("Unexpected DDL: "+text);
 }};
 return {sql,columns,indexes,duplicates:()=>duplicates,probeAlterCount:()=>probeAlterCount,lockReleased:()=>lockReleased};
}
it("concurrent first starts verify duplicate column/index winners and both complete",async()=>{
 const f=fixture();const result=await Promise.allSettled([ensureMysqlWorkInputsSchema(f.sql),ensureMysqlWorkInputsSchema(f.sql)]);
 expect(result.map(r=>r.status)).toEqual(["fulfilled","fulfilled"]);expect(f.duplicates()).toBeGreaterThan(0);
 expect(f.columns.size).toBe(4);expect(f.indexes.size).toBe(3);
 await expect(ensureMysqlWorkInputsSchema(f.sql)).resolves.toBeUndefined();
});
it.each([{wrongColumn:true},{wrongIndex:true}])("never trusts a conflicting DDL definition: %j",async options=>{
 const f=fixture(options);
 const result=await Promise.allSettled([ensureMysqlWorkInputsSchema(f.sql),ensureMysqlWorkInputsSchema(f.sql)]);
 expect(result.some(r=>r.status==="rejected")).toBe(true);
 await expect(ensureMysqlWorkInputsSchema(f.sql)).rejects.toThrow(/definition|generated/);
});
it("propagates non-duplicate DDL errors without accepting another catalog shape",async()=>{
 const failure=Object.assign(Error("DDL denied"),{code:"ER_TABLEACCESS_DENIED_ERROR",errno:1142});
 await expect(ensureMysqlWorkInputsSchema(fixture({ddlError:failure}).sql)).rejects.toBe(failure);
});
it("rejects generation expressions with changed string-literal case",async()=>{
 const f=fixture();await ensureMysqlWorkInputsSchema(f.sql);
 const key="managed_session_initial_events.work_input_invalid";
 const column=f.columns.get(key) as {expression:string};
 f.columns.set(key,{...column,expression:column.expression.replace("'bootstrap_'","'BOOTSTRAP_'")});
 await expect(ensureMysqlWorkInputsSchema(f.sql)).rejects.toThrow(/generated definition/);
});
it.each([1060,1061])("duplicate code %i without a verifiable winner is not success",async errno=>{
 const f=fixture({ddlError:Object.assign(Error("duplicate but missing definition"),{errno})});
 await expect(ensureMysqlWorkInputsSchema(f.sql)).rejects.toThrow();
});

it("rejects an additional functional key even when GROUP_CONCAT would omit its NULL column name",async()=>{
 const f=fixture({functionalKey:true});
 await expect(ensureMysqlWorkInputsSchema(f.sql)).rejects.toThrow(/definition/);
});

it.each([
 { code: "ER_DBACCESS_DENIED_ERROR", errno: 1044 },
 { code: "ER_TABLEACCESS_DENIED_ERROR", errno: 1142 },
])("falls back to an advisory-locked probe table when CREATE TEMPORARY TABLE is denied (%j)",async denied=>{
 const f=fixture({tempTableError:Object.assign(Error("CREATE TEMPORARY TABLE denied"),denied)});
 await expect(ensureMysqlWorkInputsSchema(f.sql)).resolves.toBeUndefined();
 expect(f.probeAlterCount()).toBe(4);
 expect(f.lockReleased()).toBe(4);
});

it("propagates non-privilege errors from CREATE TEMPORARY TABLE without falling back",async()=>{
 const failure=Error("connection lost");
 const f=fixture({tempTableError:failure});
 await expect(ensureMysqlWorkInputsSchema(f.sql)).rejects.toBe(failure);
 expect(f.probeAlterCount()).toBe(0);
});

it("fails closed if the fallback probe advisory lock cannot be acquired",async()=>{
 const f=fixture({tempTableError:Object.assign(Error("denied"),{code:"ER_DBACCESS_DENIED_ERROR",errno:1044}),lockAcquired:0});
 await expect(ensureMysqlWorkInputsSchema(f.sql)).rejects.toThrow(/probe lock/);
});
