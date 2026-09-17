import {renderCredentials,renderRequest,renderServiceSpec} from './render.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes, createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,lstat,copyFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';

const repository='ghcr.io/openma-ai/open-managed-agents';
export const targets = {
 docker:{mode:'image', note:'Docker: persistent SQLite volume, loopback port; E2B/Daytona/BoxRun runs sandboxes.'},
 fly:{mode:'image',note:'Fly.io: paid Machine and volume; requires fly auth login and sandbox credentials.'},
 render:{mode:'image',note:'Render: official image, paid 1c-2g service and 10 GB disk; one instance. Review billing in your Render workspace.'},
 vercel:{mode:'handoff',note:'Vercel Beta: Neon, object storage and Sandbox configuration remain required.'},
 cloudflare:{mode:'source-required',note:'Cloudflare: no standalone deployment artifact yet; use the repository setup guide.'},
} as const;
type Target=keyof typeof targets;
type Options={command:string,target:Target,dir:string,port:number,image:string,provider:string,dataMode:string,yes:boolean,json:boolean,reuseFlySecrets:boolean,url?:string,workspace?:string,region:string};
export function parseOptions(args:string[]):Options {
 const o:Options={command:'install',target:'docker',dir:'',port:8787,image:`${repository}:edge`,provider:'e2b',dataMode:'sqlite',yes:false,json:false,reuseFlySecrets:false,region:'oregon'};
 if(args[0]&&!args[0].startsWith('-')) o.command=args.shift()!;
 if(!['install','doctor','status','upgrade','login','help'].includes(o.command)) throw Error('Use install, doctor, status, upgrade, login, or help.');
 for(let i=0;i<args.length;i++) {
  const flag=args[i];
  if(flag==='--reuse-fly-secrets'){o.reuseFlySecrets=true;continue;}
  if(flag==='--yes'){o.yes=true;continue;} if(flag==='--json'){o.json=true;continue;}
  if(flag==='--help'||flag==='-h'){o.command='help';continue;}
  if(!['--target','--dir','--port','--image','--provider','--url','--data-mode','--workspace','--region'].includes(flag)) throw Error(`Unknown option: ${flag}`);
  const value=args[++i]; if(!value||value.startsWith('--')) throw Error(`Missing value for ${flag}`);
  if(flag==='--target') o.target=value as Target;
  if(flag==='--dir') o.dir=resolve(value);
  if(flag==='--port') o.port=Number(value);
  if(flag==='--image') o.image=value;
  if(flag==='--provider') o.provider=value;
  if(flag==='--data-mode') o.dataMode=value;
  if(flag==='--url') o.url=value;
  if(flag==='--workspace')o.workspace=value;
  if(flag==='--region')o.region=value;
 }
 if(!Object.hasOwn(targets,o.target)) throw Error('Choose docker, fly, render, vercel, or cloudflare.');
 if(!Number.isInteger(o.port)||o.port<1||o.port>65535) throw Error('Port must be 1–65535.');
 if(!['sqlite','postgres'].includes(o.dataMode))throw Error('Choose --data-mode sqlite or postgres.');
 if(o.reuseFlySecrets&&o.target!=='fly')throw Error('--reuse-fly-secrets is only supported for Fly.');
 if(!['e2b','daytona','boxrun','sprites'].includes(o.provider)) throw Error('Choose e2b, daytona, boxrun, or sprites.');
 if(!new RegExp('^'+repository.replaceAll('.', '\\.')+'(?::[a-zA-Z0-9_.-]+|@sha256:[a-f0-9]{64})$').test(o.image)) throw Error('Use an official OpenMA GHCR tag or sha256 digest.');
 if(!['oregon','ohio','virginia','frankfurt','singapore'].includes(o.region))throw Error('Unsupported Render region.');
 o.dir ||= join(homedir(),'.openma','self-host',o.target);
 return o;
}
async function exists(path:string) {try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
async function readJSON(path:string) {if((await lstat(path)).isSymbolicLink())throw Error(`Refusing symlink: ${path}`);return JSON.parse(await readFile(path,'utf8'));}
const secret=()=>randomBytes(32).toString('hex');
export async function configureDocker(dir:string,provider:string,env:NodeJS.ProcessEnv) {
 const path=join(dir,'environment.json');
 if(await exists(path)){const saved=await readJSON(path);if(saved.SANDBOX_PROVIDER!==provider)throw Error('Existing sandbox provider differs. Edit environment.json explicitly.');return saved;}
 const key=provider==='sprites'?'SPRITES_TOKEN':provider==='e2b'?'E2B_API_KEY':provider==='daytona'?'DAYTONA_API_KEY':'BOXRUN_URL';
 if(!env[key])throw Error(`Set ${key} in your terminal environment before installing; never pass keys as command arguments.`);
 const value:Record<string,string>={BETTER_AUTH_SECRET:secret(),PLATFORM_ROOT_SECRET:secret(),OPENMA_POSTGRES_PASSWORD:secret(),SANDBOX_PROVIDER:provider,[key]:env[key]!};
 for(const name of ['BOXRUN_TOKEN','E2B_API_URL','E2B_DOMAIN','E2B_SANDBOX_URL','DAYTONA_API_URL'])if(env[name])value[name]=env[name]!;
 await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});return value;
}
export function makeCompose(image:string,port:number,project:string) {
 return JSON.stringify({name:project,services:{'oma-server':{image,platform:'linux/amd64',ports:[`127.0.0.1:${port}:8787`],environment:{OPENMA_PROCESS_MODE:'standalone',HOST:'0.0.0.0',PORT:'8787',PUBLIC_BASE_URL:`http://localhost:${port}`,GATEWAY_ORIGIN:`http://localhost:${port}`,DATABASE_PATH:'/app/data/oma.db',AUTH_DATABASE_PATH:'/app/data/auth.db',SANDBOX_WORKDIR:'/app/data/sandboxes',MEMORY_BLOB_DIR:'/app/data/memory-blobs',FILES_BLOB_DIR:'/app/data/files-blobs',SESSION_OUTPUTS_DIR:'/app/data/session-outputs'},volumes:['openma-data:/app/data'],restart:'unless-stopped',healthcheck:{test:['CMD','node','-e',"fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval:'5s',timeout:'5s',retries:12,start_period:'30s'}}},volumes:{'openma-data':{}}},null,2)+'\n';
}
function run(cmd:string,args:string[],cwd:string,env:NodeJS.ProcessEnv=process.env,capture=false) {
 const result=spawnSync(cmd,args,{cwd,env,encoding:'utf8',stdio:capture?['ignore','pipe','pipe']:'inherit'});
 if(result.error||result.status!==0)throw Error(`${cmd} failed (${result.status??result.error?.message}). Fix the prerequisite and rerun the same command.`);
 return result.stdout?.trim()??'';
}
export async function resolveImage(image:string,fetcher:typeof fetch=fetch) {
 if(image.includes('@sha256:'))return image;
 const tokenResponse=await fetcher('https://ghcr.io/token?service=ghcr.io&scope=repository:openma-ai/open-managed-agents:pull',{signal:AbortSignal.timeout(15000)});
 if(!tokenResponse.ok)throw Error('Cannot access the public image registry.');
 const {token}=await tokenResponse.json() as {token:string};
 const response=await fetcher(`https://ghcr.io/v2/openma-ai/open-managed-agents/manifests/${image.split(':').at(-1)}`,{method:'HEAD',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json'},signal:AbortSignal.timeout(15000)});
 const digest=response.headers.get('docker-content-digest');
 if(!response.ok||!digest||!/^sha256:[a-f0-9]{64}$/.test(digest))throw Error('No published image found. Select an existing --image tag or digest.');
 return `${repository}@${digest}`;
}
export async function verify(url:string) {
 const origin=new URL(url);if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password)throw Error('Use an HTTP(S) URL without credentials.');
 const r=await fetch(new URL('/health',origin),{signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!r.ok)throw Error(`Health check failed: HTTP ${r.status}`);
 const body=await r.json() as {status?:string};if(body.status!=='ok'&&body.status!=='healthy')throw Error('Endpoint did not report healthy OpenMA status.');
 return {status:'healthy',url:origin.origin};
}
export const help=`OpenMA self-host installer (separate from the oma API CLI)
Usage: oma-self-host [install|login|doctor|status|upgrade] [options]
  --target docker|fly|render|vercel|cloudflare
  --workspace ID   Render workspace (otherwise use active Render CLI workspace)
  --region NAME    Render region (default oregon)
  --dir PATH       Installation directory (default ~/.openma/self-host/<target>)
  --provider e2b|daytona|boxrun|sprites   Credentials come from environment variables
  --image REF      Official GHCR image; default edge (development channel)
  --data-mode sqlite|postgres   Database backend (default sqlite)
  --port NUMBER    Docker localhost port (default 8787)
  --reuse-fly-secrets  Use credentials already configured in an existing Fly app
  --yes            Execute without the interactive plan confirmation
  --url URL        Verify a hosted instance with status
  --json           Machine-readable output for doctor/status
Docker uses published amd64 images (ARM hosts require Docker emulation).
No source checkout or local application build. Cloud templates are handoffs.
Upgrade requires an explicit --image, preserves configuration and volumes.
`;
export async function main(argv=process.argv.slice(2)) {
 const original=[...argv];
 const o=parseOptions([...argv]);
 if(o.command==='help'){console.log(help);return;}
 if(o.command==='install'&&original.length===0&&process.stdin.isTTY){
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try{const target=await rl.question('Platform [docker/fly/render/vercel/cloudflare] (docker): ');if(target){if(!Object.hasOwn(targets,target))throw Error('Unknown platform.');o.target=target as Target;o.dir=join(homedir(),'.openma','self-host',target);}}finally{rl.close();}
 }
 if(o.command==='login'){
  const commands:Record<string,[string,string[]]>={fly:['fly',['auth','login']],render:['render',['login']],vercel:['vercel',['login']],cloudflare:['wrangler',['login']]};
  if(o.target==='docker'){console.log('Docker does not require cloud login.');return;}
  const [cmd,args]=commands[o.target];run(cmd,args,process.cwd());return;
 }
 const statePath=join(o.dir,'installation.json');
 const saved=await exists(statePath)?await readJSON(statePath):null;
 if(saved&&saved.target!==o.target)throw Error('Installation belongs to another platform. Use its --target or another --dir.');
 if(saved?.reuseFlySecrets)o.reuseFlySecrets=true;
 if(saved&&!original.includes('--provider'))o.provider=saved.provider;
 if(saved&&!original.includes('--port'))o.port=saved.port;
 if(saved&&!original.includes('--data-mode'))o.dataMode=saved.dataMode??'sqlite';
 if(saved&&(saved.dataMode??'sqlite')!==o.dataMode)throw Error('Database changes require an explicit migration, not reinstall.');
 if(o.command==='doctor'){
  const commands=o.target==='docker'?[['docker','compose','version'],['docker','info']]:o.target==='render'?[['render','--version'],['render','whoami','-o','json']]:o.target==='fly'?[['fly','version'],['fly','auth','whoami'],['bash','--version'],['openssl','version']]:[];
  const checks=commands.map(([cmd,...args])=>{try{run(cmd,args,process.cwd(),process.env,true);return {command:cmd+' '+args.join(' '),ok:true};}catch{return {command:cmd+' '+args.join(' '),ok:false};}});
  console.log(JSON.stringify({target:o.target,...targets[o.target],checks,installed:saved?.status==='installed',directory:o.dir},null,2));
  if(checks.some(c=>!c.ok))process.exitCode=1;return;
 }
 if(o.command==='status'){
  if(o.url){console.log(JSON.stringify(await verify(o.url),null,2));return;}
  if(!saved)throw Error('No saved installation; use --dir or --url.');
  if(o.target==='docker')console.log(JSON.stringify(await verify(`http://localhost:${saved.port}`),null,2));
  else if(o.target==='render'){if(!saved.url)throw Error('Render deployment is pending. Rerun install to finish.');console.log(JSON.stringify(await verify(saved.url),null,2));}
  else if(o.target==='fly'){const status=JSON.parse(run('fly',['status','--json'],o.dir,process.env,true));console.log(JSON.stringify(await verify(`https://${status.Hostname}`),null,2));}
  else console.log(JSON.stringify({status:'handoff',...saved},null,2));return;
 }
 if(o.json)throw Error('--json is supported for doctor/status only.');
 if(o.target==='render'&&o.dataMode!=='sqlite')throw Error('Render currently supports SQLite with a persistent disk.');
 if(o.target==='cloudflare')throw Error('Cloudflare standalone artifact is not published yet. Follow https://docs.openma.dev/self-host/deploy/ (source checkout required).');
 if(o.command==='upgrade'&&(!saved||!original.includes('--image')||!['docker','fly','render'].includes(o.target)))throw Error('Upgrade requires an existing Docker/Fly/Render installation and explicit --image. Back up data first.');
 let renderAuth:Awaited<ReturnType<typeof renderCredentials>>|undefined;
 if(o.target==='render'){run('render',['login'],process.cwd());renderAuth=await renderCredentials();o.workspace ||= saved?.workspace||renderAuth.workspace;if(!o.workspace)throw Error('Select --workspace or run render workspace set.');if(saved?.workspace&&saved.workspace!==o.workspace)throw Error('Use the original Render workspace for this installation.');}
 console.log(`${targets[o.target].note}${o.target==='render'?`\nWorkspace: ${o.workspace}\nRegion: ${saved?.region||o.region}`:''}\nDirectory: ${o.dir}\nImage: ${saved&&o.command==='install'?saved.image:o.image}\nExisting secrets and persistent data are reused. Cloud and sandbox resources may incur charges.`);
 if(!o.yes){if(!process.stdin.isTTY)throw Error('Use --yes after reviewing the plan, or run interactively.');const rl=createInterface({input:process.stdin,output:process.stdout});try{if(!/^y(es)?$/i.test(await rl.question('Continue? [y/N] ')))return;}finally{rl.close();}}
 await mkdir(o.dir,{recursive:true,mode:0o700});
 if((await lstat(o.dir)).isSymbolicLink())throw Error('Installation directory must not be a symlink.');
 const record=async(state:Record<string,unknown>)=>{if(await exists(statePath)&& (await lstat(statePath)).isSymbolicLink())throw Error('Refusing symlink state file.');await writeFile(statePath,JSON.stringify({target:o.target,provider:o.provider,port:o.port,dataMode:o.dataMode,reuseFlySecrets:o.reuseFlySecrets,...state},null,2)+'\n',{mode:0o600});};
 if(o.target==='vercel'){
  const url='https://openma.dev/deploy/?provider=vercel';
  await record({status:'handoff',url});console.log(`Continue in your browser: ${url}\nNot installed yet. After deployment: oma-self-host status --url https://YOUR-SERVICE`);return;
 }
 const image=saved&&o.command==='install'?saved.image:await resolveImage(o.image);
 if(o.target==='render'){
  const token=renderAuth!.token;const owner=o.workspace!;
  const name='openma-'+createHash('sha256').update(o.dir).digest('hex').slice(0,10);
  let serviceId=saved?.serviceId as string|undefined;
  const renderRecord=async(extra:Record<string,unknown>)=>record({image,workspace:owner,region:saved?.region||o.region,name,serviceId,status:'pending',...extra});
  if(!serviceId){
   const matches=await renderRequest(token,`/services?ownerId=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}&limit=100`);
   const found=matches.map((x:any)=>x.service??x).filter((x:any)=>x.name===name);
   if(found.length){if(!saved?.creationRequested||found.length!==1)throw Error('A Render service with this name already exists. Reconcile it before retrying.');serviceId=found[0].id;}
   else{
    const environment=await configureDocker(o.dir,o.provider,process.env);
    await renderRecord({creationRequested:true});
    const result=await renderRequest(token,'/services','POST',renderServiceSpec({owner,name,region:o.region,image},environment));
    serviceId=(result.service??result).id;
    if(!serviceId)throw Error('Render creation response was incomplete. Rerun install to reconcile the service.');
   }
  }
  await renderRecord({serviceId});
  if(o.command==='upgrade')run('render',['deploys','create',serviceId!,'--image',image,'--wait','--confirm','-o','json'],o.dir,process.env,true);
  console.log(`Waiting for Render service ${serviceId}…`);
  for(let attempt=0;attempt<120;attempt++){
   const deploys=await renderRequest(token,`/services/${encodeURIComponent(serviceId!)}/deploys?limit=1`);
   const state=(deploys[0]?.deploy??deploys[0])?.status;
   if(['build_failed','update_failed','canceled','pre_deploy_failed'].includes(state))throw Error(`Render deployment ${state}. Inspect the service logs and fix/redeploy in Render; rerun install to check it.`);
   if(state==='live'){
    const service=await renderRequest(token,`/services/${encodeURIComponent(serviceId!)}`);
    const url=(service.service??service).serviceDetails?.url;
    if(typeof url!=='string')throw Error('Render did not return a service URL.');
    const health=await verify(url);await renderRecord({serviceId,status:'installed',url:health.url});console.log(`OpenMA is healthy: ${health.url}`);return;
   }
   await delay(10000);
  }
  throw Error('Render is still deploying. Rerun install to resume checking the existing service.');
 }
 if(o.target==='fly'){
  await mkdir(join(o.dir,'scripts'),{recursive:true});
  const assets=join(dirname(fileURLToPath(import.meta.url)),'assets');
  for(const [src,dest] of [['setup-fly.sh','scripts/setup-fly.sh'],['fly.toml','fly.toml']])if(!await exists(join(o.dir,dest)))await copyFile(join(assets,src),join(o.dir,dest));
  if(o.reuseFlySecrets){
   const status=JSON.parse(run('fly',['status','--json'],o.dir,process.env,true));
   if(!status.Name)throw Error('An existing app in fly.toml is required to reuse Fly secrets.');
   const secrets=JSON.parse(run('fly',['secrets','list','--json'],o.dir,process.env,true)) as {name:string}[];
   const names=new Set(secrets.map(item=>item.name));
   const key=o.provider==='sprites'?'SPRITES_TOKEN':o.provider==='e2b'?'E2B_API_KEY':o.provider==='daytona'?'DAYTONA_API_KEY':'BOXRUN_URL';
   for(const name of ['BETTER_AUTH_SECRET','PLATFORM_ROOT_SECRET','SANDBOX_PROVIDER',key])if(!names.has(name))throw Error(`Existing Fly app is missing ${name}.`);
   await record({image,status:'pending'});
   run('fly',['deploy','--image',image,'--strategy','rolling','--ha=false',...(o.yes?['--yes']:[])],o.dir);
  }else{
  await record({image,status:'pending'});
  run('bash',['scripts/setup-fly.sh'],o.dir,{...process.env,OPENMA_FLY_IMAGE:image,OPENMA_FLY_BUILD_FROM_SOURCE:'0',OPENMA_FLY_DATA_MODE:o.dataMode,OPENMA_FLY_SANDBOX_PROVIDER:o.provider});
  }
  const status=JSON.parse(run('fly',['status','--json'],o.dir,process.env,true));
  const health=await verify(`https://${status.Hostname}`);
  await record({image,status:'installed',url:health.url});console.log(`OpenMA is healthy: ${health.url}`);return;
 }
 run('docker',['compose','version'],process.cwd(),process.env,true);run('docker',['info'],process.cwd(),process.env,true);
 const environment=await configureDocker(o.dir,o.provider,process.env);
 const project='openma-'+createHash('sha256').update(o.dir).digest('hex').slice(0,10);
 const compose=JSON.parse(makeCompose(image,o.port,project));
 // JSON is valid Compose input; escape dollars so Compose never interpolates credentials.
 for(const [key,value] of Object.entries(environment))compose.services['oma-server'].environment[key]=String(value).replaceAll('$',()=> '$$');
 if(o.dataMode==='postgres'){
  compose.services.postgres={image:'postgres:16-alpine',environment:{POSTGRES_USER:'oma',POSTGRES_DB:'oma',POSTGRES_PASSWORD:environment.OPENMA_POSTGRES_PASSWORD},volumes:['openma-postgres:/var/lib/postgresql/data'],restart:'unless-stopped',healthcheck:{test:['CMD-SHELL','pg_isready -U oma -d oma'],interval:'5s',timeout:'5s',retries:12}};
  compose.services['oma-server'].environment.DATABASE_URL=`postgres://oma:${environment.OPENMA_POSTGRES_PASSWORD}@postgres:5432/oma`;
  compose.services['oma-server'].depends_on={postgres:{condition:'service_healthy'}};
  compose.volumes['openma-postgres']={};
 }
 const config=join(o.dir,'compose.json');
 if(await exists(config)&&(await lstat(config)).isSymbolicLink())throw Error('Refusing symlink compose file.');
 if(o.command==='upgrade'&&await exists(config))await copyFile(config,join(o.dir,'compose.previous.json'));
 await writeFile(config,JSON.stringify(compose,null,2)+'\n',{mode:0o600});
 await record({image,status:'pending',previousImage:saved?.image});
 const args=['compose','--project-name',project,'-f',config];
 run('docker',[...args,'pull'],o.dir);
 run('docker',[...args,'up','--no-build','--wait','--wait-timeout','180'],o.dir);
 const health=await verify(`http://localhost:${o.port}`);
 await record({image,status:'installed',previousImage:saved?.image});
 console.log(`OpenMA is healthy: ${health.url}\nCreate your account and add a Model Card. Back up ${o.dir} and Docker volume ${project}_openma-data.`);
}
