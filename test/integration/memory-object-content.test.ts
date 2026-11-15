// CF binding wiring and metadata separation, local Miniflare (not live R2).
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
it("CF managed Memory current/version bytes use object storage and SQL metadata only", async () => {
  const api = (path:string, body?:unknown) => exports.default.fetch(new Request("http://localhost"+path, {method:body===undefined?"GET":"POST",headers:{"x-api-key":"test-key","content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}));
  const json = async(path:string, body?:unknown) => {const r=await api(path,body);expect(r.ok,await r.clone().text()).toBe(true);return r.json() as Promise<any>;};
  const store=await json("/v1/memory_stores",{name:"object-content"});
  const value="CF content β\nexact";
  const memory=await json(`/v1/memory_stores/${store.id}/memories?view=full`,{path:"/fact.md",content:value});
  expect(memory.content).toBe(value);
  for(const table of ["managed_memories","managed_memory_versions"]){
    const row=await env.MAIN_DB!.prepare(`SELECT document FROM ${table} WHERE memory_store_id=?`).bind(store.id).first<{document:string}>();
    const metadata=JSON.parse(row!.document);
    expect(metadata).not.toHaveProperty("content");
    expect(await (await env.MEMORY_BUCKET!.get(metadata.contentObjectKey))!.text()).toBe(value);
  }
  expect((await json(`/v1/memory_stores/${store.id}/memories/${memory.id}?view=full`)).content).toBe(value);
  expect((await json(`/v1/memory_stores/${store.id}/memory_versions/${memory.memory_version_id}?view=full`)).content).toBe(value);
});
