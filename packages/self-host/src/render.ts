import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {parse} from 'yaml';

type Selection={owner:string,name:string,region:string,image:string};
export function renderServiceSpec(o:Selection,environment:Record<string,string>){
 return {type:'web_service',name:o.name,ownerId:o.owner,autoDeploy:'no',image:{imagePath:o.image,ownerId:o.owner},
  envVars:Object.entries({OPENMA_PROCESS_MODE:'standalone',HOST:'0.0.0.0',PORT:'8787',DATABASE_PATH:'/app/data/oma.db',AUTH_DATABASE_PATH:'/app/data/auth.db',SANDBOX_WORKDIR:'/app/data/sandboxes',MEMORY_BLOB_DIR:'/app/data/memory-blobs',FILES_BLOB_DIR:'/app/data/files-blobs',SESSION_OUTPUTS_DIR:'/app/data/session-outputs',...environment}).map(([key,value])=>({key,value})),
  serviceDetails:{runtime:'image',plan:'1c-2g',region:o.region,numInstances:1,healthCheckPath:'/health',disk:{name:'openma-data',mountPath:'/app/data',sizeGB:10},envSpecificDetails:{dockerCommand:'sh -c \'export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-$RENDER_EXTERNAL_URL}"; export GATEWAY_ORIGIN="${GATEWAY_ORIGIN:-$PUBLIC_BASE_URL}"; exec pnpm start\''}}};
}
export async function renderCredentials(){
 let config:any={};
 try{config=parse(await readFile(join(process.env.RENDER_CLI_CONFIG_DIR||join(homedir(),'.render'),'cli.yaml'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Cannot read Render CLI configuration. Run render login again.');}
 const token=process.env.RENDER_API_KEY||config?.api?.key;
 if(typeof token!=='string'||!token)throw Error('Render authentication is missing. Run oma-self-host login --target render.');
 return {token,workspace:config?.workspace as string|undefined};
}
export async function renderRequest(token:string,path:string,method='GET',body?:unknown){
 const response=await fetch(`https://api.render.com/v1${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000),redirect:'error'});
 if(!response.ok)throw Error(`Render API ${method} failed: HTTP ${response.status}. Check your account and rerun; credentials are not logged.`);
 return response.json() as Promise<any>;
}
