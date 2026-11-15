import os,json,pathlib,subprocess,http.server,threading,queue,time
out=pathlib.Path(__file__).parent;root=pathlib.Path(os.environ['KIMI_TEST_HOME']);root.mkdir(exist_ok=True);agent=root/'agent';agent.mkdir(exist_ok=True);requests=[];events=[]
class H(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  b=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append(b);names=[t['name'] for t in b['tools']]
  if len(requests)==1: blocks=[('original_alpha','mcp__oma__approve',{'label':'same'})]
  elif 'APPROVED-CANONICAL-2052' in json.dumps(b.get('messages',[])): blocks=[]
  else: raise AssertionError('Kimi sampled without observing the canonical answer')
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  def e(t,**kw):self.wfile.write(('event: '+t+'\ndata: '+json.dumps({'type':t,**kw})+'\n\n').encode());self.wfile.flush()
  e('message_start',message={'id':'msg_'+str(len(requests)),'type':'message','role':'assistant','model':'fixture','content':[],'stop_reason':None,'usage':{'input_tokens':10,'output_tokens':0}})
  for i,(cid,name,args) in enumerate(blocks):
   e('content_block_start',index=i,content_block={'type':'tool_use','id':cid,'name':name,'input':{}});e('content_block_delta',index=i,delta={'type':'input_json_delta','partial_json':json.dumps(args)});e('content_block_stop',index=i)
  if not blocks:e('content_block_start',index=0,content_block={'type':'text','text':'DONE'});e('content_block_stop',index=0)
  e('message_delta',delta={'stop_reason':'tool_use' if blocks else 'end_turn','stop_sequence':None},usage={'output_tokens':10});e('message_stop')
s=http.server.HTTPServer(('127.0.0.1',0),H);threading.Thread(target=s.serve_forever,daemon=True).start()
(agent/'models.json').write_text(json.dumps({'providers':{'fixture':{'baseUrl':f'http://127.0.0.1:{s.server_port}','api':'anthropic-messages','apiKey':'fixture-not-secret','models':[{'id':'fixture'}]}}}));(agent/'settings.json').write_text(json.dumps({'defaultProvider':'fixture','defaultModel':'fixture','quietStartup':True}))
(root/'config.toml').write_text('default_model = "oma"\n[providers.oma]\ntype = "anthropic"\nbase_url = "http://127.0.0.1:'+str(s.server_port)+'/v1"\napi_key_env = "FIXTURE_TOKEN"\n[models.oma]\nprovider = "oma"\nmodel = "fixture"\nmax_context_size = 262144\n')
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(root),'KIMI_CODE_HOME':str(root),'KIMI_DISABLE_TELEMETRY':'true','FIXTURE_TOKEN':'fixture-not-secret'}
(root/'mcp.json').write_text(json.dumps({'mcpServers':{'oma':{'command':'node','args':[str(out/'kimi-core-stdio.mjs'),os.environ['CORE_BRIDGE']]}}}))
p=subprocess.Popen(['/usr/local/bin/node',os.environ['KIMI_OFFICIAL_EXECUTABLE'],'acp'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,cwd=root);q=queue.Queue();threading.Thread(target=lambda:[q.put(json.loads(x)) for x in p.stdout],daemon=True).start()
def rpc(i,m,params):
 if m=='session/prompt':
  deadline=time.monotonic()+15
  while time.monotonic()<deadline:
   if any('mcp.tools_discovered' in f.read_text() for f in root.glob('sessions/*/*/agents/main/wire.jsonl')):break
   time.sleep(.05)
  else:raise AssertionError('MCP discovery not durable before prompt')
 p.stdin.write(json.dumps({'jsonrpc':'2.0','id':i,'method':m,'params':params})+'\n');p.stdin.flush()
 while True:
  x=q.get(timeout=45);events.append(x)
  if x.get('method')=='session/request_permission':
   import urllib.request
   req=urllib.request.Request(os.environ['CORE_BRIDGE']+'/permission',data=json.dumps(x['params']['toolCall']).encode(),headers={'Content-Type':'application/json'})
   urllib.request.urlopen(req).read()
   p.stdin.write(json.dumps({'jsonrpc':'2.0','id':x['id'],'result':{'outcome':{'outcome':'selected','optionId':next(o['optionId'] for o in x['params']['options'] if o['kind']=='allow_once')}}})+'\n');p.stdin.flush()
  if x.get('id')==i:return x
try:
 rpc(1,'initialize',{'protocolVersion':1,'clientCapabilities':{}})
 n=rpc(2,'session/new',{'cwd':str(root),'mcpServers':[]});sid=n['result']['sessionId'];r=rpc(3,'session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'Invoke the MCP tool mcp__oma__approve with label same, await its answer, then report that answer.'}]});assert r['result']['stopReason']=='end_turn',r;assert 'APPROVED-CANONICAL-2052' in json.dumps(requests[1:]), 'No actual MCP answer observed'
 assert 'original_alpha' in json.dumps(events)
 print('KIMI_CANONICAL_ANSWER_OBSERVED')
finally:
 p.terminate();p.wait(timeout=10);s.shutdown();(pathlib.Path(os.environ['KIMI_TEST_TRACE'])).write_text(json.dumps({'requests':requests,'events':events,'stderr':p.stderr.read()},indent=2))
