// Opt-in IO bridge: workerd R2 binding shape -> actual task S3 operations.
// No resource policy, canonical reconciliation, tool execution or model logic.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
const {S3Client,GetObjectCommand,HeadObjectCommand,PutObjectCommand,DeleteObjectCommand,ListObjectsV2Command}=createRequire(new URL('../../packages/blob-store/package.json',import.meta.url))('@aws-sdk/client-s3');
if(!process.env.RESOURCE_R2_TASK_CREDENTIAL_FILE)throw Error('Explicit task credential file required');
const c=JSON.parse(readFileSync(process.env.RESOURCE_R2_TASK_CREDENTIAL_FILE,'utf8'));
for(const k of ['ENDPOINT','REGION','BUCKET','ACCESS_KEY','SECRET_KEY'])if(typeof c['MEMORY_S3_'+k]!=='string')throw Error('Missing MEMORY_S3_'+k);
const prefix='resource-memory-1913/'+randomUUID()+'/';
const client=new S3Client({endpoint:c.MEMORY_S3_ENDPOINT,region:c.MEMORY_S3_REGION,forcePathStyle:true,requestChecksumCalculation:'WHEN_REQUIRED',credentials:{accessKeyId:c.MEMORY_S3_ACCESS_KEY,secretAccessKey:c.MEMORY_S3_SECRET_KEY}});
const key=k=>{if(typeof k!=='string'||k.startsWith('/')||k.split('/').some(x=>x==='..'))throw Error('Invalid task key');return prefix+k;};
let puts=0;
const send=(C,args)=>client.send(new C({Bucket:c.MEMORY_S3_BUCKET,...args}));
const server=createServer(async(req,res)=>{try{
 let raw='';for await(const b of req)raw+=b;const i=JSON.parse(raw||'{}');let result;
 if(req.url==='/info')result={prefix,bucket:c.MEMORY_S3_BUCKET};
 else if(req.url==='/list'){const p=await send(ListObjectsV2Command,{Prefix:key(i.prefix??''),ContinuationToken:i.cursor});result={objects:(p.Contents??[]).map(o=>({key:o.Key.slice(prefix.length),size:o.Size})),truncated:p.IsTruncated,cursor:p.NextContinuationToken};}
 else if(req.url==='/get'||req.url==='/head'){try{const o=await send(req.url==='/get'?GetObjectCommand:HeadObjectCommand,{Key:key(i.key)});result={etag:o.ETag?.replaceAll('"',''),size:o.ContentLength,...(o.Body?{text:await o.Body.transformToString()}: {})};}catch(e){if(e.$metadata?.httpStatusCode===404)result=null;else throw e;}}
 else if(req.url==='/put'){try{const o=await send(PutObjectCommand,{Key:key(i.key),Body:i.text,...(i.etag?{IfMatch:i.etag}: {})});puts++;result={etag:o.ETag?.replaceAll('"','')};console.log(JSON.stringify({op:'memory.r2.put',key:i.key,bytes:Buffer.byteLength(i.text),sha256:createHash('sha256').update(i.text).digest('hex')}));}catch(e){if(e.$metadata?.httpStatusCode===412)result=null;else throw e;}}
 else if(req.url==='/delete'){for(const k of Array.isArray(i.key)?i.key:[i.key])await send(DeleteObjectCommand,{Key:key(k)});result={};}
 else if(req.url==='/verify'){let cursor;const objects=[];do{const p=await send(ListObjectsV2Command,{Prefix:prefix,ContinuationToken:cursor});for(const o of p.Contents??[]){if(!o.Key.endsWith('/fact.md')&&!o.Key.endsWith('/seed.md'))continue;const value=await send(GetObjectCommand,{Key:o.Key});const text=await value.Body.transformToString();objects.push({key:o.Key,text,sha256:createHash('sha256').update(text).digest('hex')});}cursor=p.IsTruncated?p.NextContinuationToken:undefined;}while(cursor);result={prefix,puts,objects};console.log(JSON.stringify({op:'memory.r2.independent_verify',...result}));}
 else throw Error('Unsupported task operation');
 res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
 }catch(e){console.error(JSON.stringify({op:'memory.r2.failure',name:e.name,status:e.$metadata?.httpStatusCode}));res.statusCode=500;res.end(JSON.stringify({error:'Task S3 operation failed',name:e.name,status:e.$metadata?.httpStatusCode}));}});
server.listen(47659,'127.0.0.1',()=>console.log(JSON.stringify({op:'memory.r2.gateway_ready',port:47659,prefix})));
process.on('SIGTERM',()=>server.close(()=>{client.destroy();process.exit(0);}));
