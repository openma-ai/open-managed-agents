import os,json,subprocess,threading,http.server,pathlib,queue,time,sys
base=pathlib.Path.cwd(); plan=json.loads(pathlib.Path(sys.argv[1]).read_text()); root=pathlib.Path(plan['root']); root.mkdir(parents=True,exist_ok=True); agent=pathlib.Path(plan['answersPath']).parent;agent.mkdir(parents=True,exist_ok=True)
case=plan['case']; is_old=plan.get('old',False)
(agent/'models.json').write_text(json.dumps({'providers':{'oma-fixture':{'baseUrl':'http://127.0.0.1:18998','api':'anthropic-messages','apiKey':'isolated-fixture-not-secret','models':[{'id':'fixture'}]}}}))
(agent/'settings.json').write_text(json.dumps({'defaultProvider':'oma-fixture','defaultModel':'fixture','quietStartup':True}))

(agent/'oma-custom-results.json').write_text('{}')
requests=[]
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if self.path=='/mcp':
   method=body.get('method'); result={}
   if method=='initialize': result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'owned-effects-fixture','version':'1'}}
   elif method=='tools/list': result={'tools':[{'name':'effect','description':'Record one approval workflow effect','inputSchema':{'type':'object','properties':{}}}]}
   elif method=='tools/call':
    with (root/'mcp-effect.txt').open('a') as f:f.write('mcp-effect\n')
    result={'content':[{'type':'text','text':'recorded'}]}
   if 'id' not in body: self.send_response(202);self.end_headers();return
   b=json.dumps({'jsonrpc':'2.0','id':body['id'],'result':result}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b);return
  requests.append(body)
  tools=[t['name'] for t in body['tools']]
  if 'approve' not in tools:
   b=json.dumps({'type':'error','error':{'type':'invalid_request_error','message':'Custom approve tool not advertised'}}).encode();self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b);return
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  def event(kind,**data):self.wfile.write(('event: '+kind+'\ndata: '+json.dumps({'type':kind,**data})+'\n\n').encode());self.wfile.flush()
  event('message_start',message={'id':'msg_'+str(len(requests)),'type':'message','role':'assistant','model':'fixture','content':[],'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':0}})
  if case=='mcp' and len(requests)==1:
   assert 'tool_search' in tools
   event('content_block_start',index=0,content_block={'type':'tool_use','id':'call_discovery','name':'tool_search','input':{}});event('content_block_delta',index=0,delta={'type':'input_json_delta','partial_json':json.dumps({'query':'approval workflow effect'})});event('content_block_stop',index=0);reason='tool_use'
  elif len(requests)==(2 if case=='mcp' else 1):
   for index,(name,args) in enumerate(([('bash',{'command':'echo side-effect >> '+str(root/'effect.txt')}),('approve',{})] if case=='custom-last' else [('approve',{}),('bash',{'command':'echo side-effect >> '+str(root/'effect.txt')})]+([('approve_second',{})] if case in ['multiple','partial'] else [])+([(next(t for t in tools if t.endswith('__effect')), {})] if case=='mcp' else []))):
    event('content_block_start',index=index,content_block={'type':'tool_use','id':'call_'+name,'name':name,'input':{}});event('content_block_delta',index=index,delta={'type':'input_json_delta','partial_json':json.dumps(args)});event('content_block_stop',index=index)
   reason='tool_use'
  else:
   event('content_block_start',index=0,content_block={'type':'text','text':''});event('content_block_delta',index=0,delta={'type':'text_delta','text':'DONE'});event('content_block_stop',index=0);reason='end_turn'
  event('message_delta',delta={'stop_reason':reason,'stop_sequence':None},usage={'output_tokens':20});event('message_stop')

server=http.server.HTTPServer(('127.0.0.1',18998),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
p=subprocess.Popen(['node',str(base/'node_modules/@openma/pi-acp/dist/bin.js'),'--agent-dir',str(agent)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'HOME':'/home/oma-worker','OMA_CUSTOM_PROBE_DIR':str(root)})
q=queue.Queue();threading.Thread(target=lambda:[q.put(json.loads(x)) for x in p.stdout],daemon=True).start();events=[]
def rpc(i,method,params):
 p.stdin.write(json.dumps({'jsonrpc':'2.0','id':i,'method':method,'params':params})+'\n');p.stdin.flush()
 end=time.monotonic()+40
 while time.monotonic()<end:
  x=q.get(timeout=40);events.append(x)
  if x.get('id')==i:return x
try:
 init=rpc(1,'initialize',{'protocolVersion':1,'clientCapabilities':{},'clientInfo':{'name':'oma-owned-diagnostic','version':'1'}})
 new=rpc(2,'session/new',{'cwd':str(root),'mcpServers':([{'type':'http','name':'effects','url':'http://127.0.0.1:18998/mcp','headers':[]}] if case=='mcp' else []),'_meta':{'openma':{'session_id':'isolated-advertising-probe','tools':[{'type':'custom','name':'approve','description':'Approve operation','input_schema':{'type':'object','properties':{}}}]}}})
 sid=new['result']['sessionId']; result=rpc(3,'session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'Call approve.'}]})
 print(json.dumps({'phase':'park','result':result,'requestCount':len(requests),'effect':(root/'effect.txt').read_text() if (root/'effect.txt').exists() else None}),flush=True)
 assert len(requests)==(2 if case=='mcp' else 1)
 assert 'approve' in [t['name'] for t in requests[0]['tools']], 'Custom approve tool not advertised'
 assert (root/'effect.txt').read_text()=='side-effect\n'
 (agent/'oma-custom-results.json').write_text(json.dumps({**{'call_approve':{'content':[{'type':'text','text':'APPROVED'}]}},**({'call_approve_second':{'content':[{'type':'text','text':'APPROVED_SECOND'}]}} if case in ['multiple','partial'] else {})}))
 if case=='mcp': assert (root/'mcp-effect.txt').read_text()=='mcp-effect\n'
 if case=='partial':
  partial={'call_approve':{'content':[{'type':'text','text':'APPROVED'}]}}
  complete=(agent/'oma-custom-results.json').read_text()
  (agent/'oma-custom-results.json').write_text(json.dumps(partial))
  partial_result=rpc(9,'session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'Premature partial result'}]})
  print(json.dumps({'phase':'partial-negative','result':partial_result,'requestCount':len(requests)}),flush=True)
  assert len(requests)==1, 'partial custom result caused early model sampling'
  (agent/'oma-custom-results.json').write_text(complete)
 if case=='restart':
  p.terminate();p.wait(timeout=10)
  p=subprocess.Popen(['node',str(base/'node_modules/@openma/pi-acp/dist/bin.js'),'--agent-dir',str(agent)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'HOME':'/home/oma-worker'})
  q=queue.Queue();threading.Thread(target=lambda:[q.put(json.loads(x)) for x in p.stdout],daemon=True).start()
  rpc(11,'initialize',{'protocolVersion':1,'clientCapabilities':{}})
  loaded=rpc(12,'session/load',{'sessionId':sid,'cwd':str(root),'mcpServers':([{'type':'http','name':'effects','url':'http://127.0.0.1:18998/mcp','headers':[]}] if case=='mcp' else [])})
  assert 'result' in loaded, loaded
 result2=rpc(4,'session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'Continue with the provided custom result.'}]})
 print(json.dumps({'uid':os.getuid(),'case':case,'sessionId':sid,'result':result2,'requests':requests,'events':events}),flush=True)
 assert len(requests)==(3 if case=='mcp' else 2)
 assert (root/'effect.txt').read_text()=='side-effect\n'
 assert 'APPROVED' in json.dumps(requests[-1]['messages'])
 assert result2['result']['stopReason']=='end_turn'
 assert sum(1 for e in events if e.get('result',{}).get('stopReason')=='end_turn')==1

finally:
 p.terminate();p.wait(timeout=10);print(json.dumps({'stderr':p.stderr.read()}));server.shutdown()
