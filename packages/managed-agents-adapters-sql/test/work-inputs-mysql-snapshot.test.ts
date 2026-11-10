import { expect,it } from "vitest";
import { URL,fileURLToPath } from "node:url";
import { migrateNodeMysqlSchema } from "../../db-schema/src/node-mysql/index";
import type { SqlClient } from "@open-managed-agents/sql-client";
it("recognizes the legal 0034 identity without re-running previous structural transitions",async()=>{
 let installed="6f23cfa4-a1c3-4c7a-8efa-040a495a1191";const ddl:string[]=[];
 const sql:SqlClient={prepare:text=>{let values:unknown[]=[];return {bind(...args:unknown[]){values=args;return this;},
  first:async()=> (text.includes("GET_LOCK")?{acquired:1}:text.includes("SELECT snapshot_id")?{snapshot_id:installed}:null) as never,
  all:async()=>({results:[]}),run:async()=>{if(text.includes("INSERT INTO openma_schema_metadata"))installed=String(values[1]);return {meta:{changes:1}};}};},batch:async()=>[],exec:async text=>{ddl.push(text);}};
 await expect(migrateNodeMysqlSchema(sql,fileURLToPath(new URL("../../../apps/main-node/migrations-sqlite",import.meta.url)))).resolves.toBeUndefined();
 expect(installed).toBe("7a941c58-b1de-4d32-83e6-545034000001");
 expect(ddl.some(s=>s.startsWith("ALTER TABLE")||s.startsWith("DROP TABLE"))).toBe(false);
});
