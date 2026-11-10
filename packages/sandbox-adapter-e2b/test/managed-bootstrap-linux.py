"""Real Linux root/process regression. Run in a disposable local container only.
Uses synthetic credentials; prints assertion names, never credential contents.
"""
import json
import os
import pwd
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE.parent / "template"


def wait(check):
    for _ in range(300):
        try:
            value = check()
            if value:
                return value
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(.01)
    raise AssertionError("bounded process observation timed out")


def live(pid):
    try:
        return Path('/proc/%s/stat' % pid).read_text().split(') ')[1][0] != 'Z'
    except FileNotFoundError:
        return False


class NativeRegression(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="oma-bootstrap-", dir="/workspace")
        self.base = Path(self.temp.name)
        self.base.chmod(0o777)
        self.directory = self.base / 'private'
        self.directory.mkdir()
        self.daemon = subprocess.Popen(['/usr/bin/python3', '-I', '-S', str(TEMPLATE / 'launcher.py'), str(self.directory)],
                                       env={**os.environ, 'IMAGE_SECRET': 'synthetic-image-only', 'NODE_OPTIONS': '--require=/nonexistent/poison.cjs', 'BASH_ENV': str(self.base / 'poison.sh'), 'ENV': str(self.base / 'poison.sh')},
                                       stdout=subprocess.DEVNULL)
        wait(lambda: (self.directory / 'ready').exists())
        Path('/run/oma-managed').mkdir(parents=True, mode=0o700, exist_ok=True)
        self.pids = []

    def tearDown(self):
        if self.daemon.poll() is None:
            self.daemon.terminate()
            self.daemon.wait(timeout=5)
        for pid in self.pids:
            if live(pid):
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    os.kill(pid, signal.SIGKILL)
        self.temp.cleanup()

    def request(self, body, ident=None):
        ident = ident or str(uuid.uuid4())
        response = self.directory / (ident + '.response.json')
        response.unlink(missing_ok=True)
        (self.directory / (ident + '.json')).write_text(json.dumps({**body, 'id': ident}))
        (self.directory / (ident + '.go')).touch()
        return wait(lambda: json.loads(response.read_text()))

    def start(self, code, env=None, ident=None):
        result = self.request({'op': 'start', 'spec': {'command': '/usr/bin/python3', 'args': ['-I', '-S', '-c', code],
                              'cwd': str(self.base), 'env': env or {}}}, ident)
        self.assertTrue(result['ok'], result)
        self.pids.append(result['pid'])
        return result

    def test_agent_cannot_read_or_signal_worker_and_worker_can_spawn_agent(self):
        worker = self.start('import time;time.sleep(60)', {'SYNTHETIC_WORK_TOKEN': 'review-only-not-real'})
        agent = pwd.getpwnam('oma-worker')
        probe = """import os,sys,json
pid=int(sys.argv[1]); result={}
for name,action in [('environment',lambda:open('/proc/%s/environ'%pid,'rb').read()),('signal',lambda:os.kill(pid,0))]:
 try: action(); result[name]='ALLOWED'
 except PermissionError: result[name]='DENIED'
print(json.dumps(result))
"""
        result = subprocess.run(['/usr/bin/python3', '-I', '-S', '-c', probe, str(worker['pid'])],
                                user=agent.pw_uid, group=agent.pw_gid, extra_groups=[], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), {'environment': 'DENIED', 'signal': 'DENIED'})
        output = self.base / 'agent.json'
        # Uses the actual installed common 0.13.1 NodeSpawner through our wrapper.
        script = self.base / 'worker.mjs'
        script.write_text("import { NodeSpawner } from 'file:///common/dist/acp-runtime/spawners/node.js';\n"
                          "import { isolateE2BAgentSpawner } from 'file:///source/template/agent-spawner.mjs';\n"
                          "import { writeFile } from 'node:fs/promises';\n"
                          "const spawner=isolateE2BAgentSpawner(new NodeSpawner());\n"
                          "const child=await spawner.spawn({command:'/usr/local/bin/node',args:['-e',"
                          + json.dumps("let escalated=false;try{process.setuid(0);escalated=true}catch{};process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),env:process.env,escalated}));process.stdin.pipe(process.stdout)")
                          + "],env:{ONLY:'agent'}});\n"
                          "const reader=child.stdout.getReader(); const first=await reader.read();\n"
                          "await writeFile(" + json.dumps(str(output)) + ",first.value);\n"
                          "const writer=child.stdin.getWriter();await writer.write(new TextEncoder().encode('ACP-local-stdio'));await writer.close();\n"
                          "let text='';for(;;){const r=await reader.read();if(r.done)break;text+=new TextDecoder().decode(r.value)}\n"
                          "if(text!=='ACP-local-stdio')throw Error('stdio failed');await child.exited;\n"
                          "await writeFile(" + json.dumps(str(self.base / "stdio-completed")) + ",'ok');\n")
        launched = self.request({'op': 'start', 'spec': {'command': '/usr/local/bin/node', 'args': [str(script)], 'cwd': str(self.base),
                              'env': {'SYNTHETIC_WORK_TOKEN': 'review-only-not-real', 'ANTHROPIC_WORK_SECRET': 'synthetic-secret'}}})
        self.assertTrue(launched['ok'])
        data = wait(lambda: json.loads(output.read_text()))
        # This image's Node 24.22.2 adds UV_USE_IO_URING=0 even under env -i.
        if data['env'].get('UV_USE_IO_URING') == '0':
            del data['env']['UV_USE_IO_URING']
        self.assertEqual(data['env'], {'ONLY': 'agent'})
        self.assertEqual(data['uid'], agent.pw_uid)
        self.assertEqual(data['gid'], agent.pw_gid)
        self.assertFalse(data['escalated'])
        wait(lambda: (self.base / 'stdio-completed').exists())
        self.assertNotIn('ANTHROPIC_WORK_SECRET', data['env'])
        self.assertNotIn('SYNTHETIC_WORK_TOKEN', data['env'])
        wait(lambda: self.request({'op': 'status', 'target': launched['id']})['status'] == 'exited')
        self.assertTrue(live(worker['pid']))

    def test_native_worker_replacement_env_and_literal_argv(self):
        output = self.base / 'native.json'
        hook = self.base / 'poison.sh'
        hook.write_text('touch ' + str(self.base / 'executed'))
        args = ["quote'", '$(touch injected)', 'line\nbreak']
        code = "require('fs').writeFileSync(" + json.dumps(str(output)) + ",JSON.stringify({env:process.env,args:process.argv.slice(1),cwd:process.cwd()}))"
        result = self.request({'op': 'start', 'spec': {'command': '/usr/local/bin/node', 'args': ['-e', code] + args,
                             'cwd': str(self.base), 'env': {'ONLY': 'yes'}}})
        self.assertTrue(result['ok'])
        wait(lambda: self.request({'op': 'status', 'target': result['id']})['status'] == 'exited')
        observed = json.loads(output.read_text())
        if observed['env'].get('UV_USE_IO_URING') == '0':
            del observed['env']['UV_USE_IO_URING']
        self.assertEqual(observed, {'env': {'ONLY': 'yes'}, 'args': args, 'cwd': str(self.base)})
        self.assertFalse((self.base / 'executed').exists())
        self.assertFalse((self.base / 'injected').exists())

    def test_duplicate_request_never_replaces_original_process(self):
        ident = str(uuid.uuid4())
        first = self.start('import time;time.sleep(60)', ident=ident)
        replay = self.request({'op': 'start', 'spec': {'command': '/usr/bin/python3', 'args': ['-c', 'import time;time.sleep(60)'], 'env': {}, 'cwd': str(self.base)}}, ident)
        if replay.get('pid'):
            self.pids.append(replay['pid'])
        self.assertTrue(not replay['ok'] or replay['pid'] == first['pid'], 'duplicate request spawned another PID')
        self.daemon.terminate(); self.daemon.wait(timeout=5)
        wait(lambda: not live(first['pid']))

    def descendant(self):
        output = self.base / 'descendant.pid'
        code = "import subprocess,pathlib;child=subprocess.Popen(['/usr/bin/python3','-c','import time;time.sleep(60)']);pathlib.Path(" + repr(str(output)) + ").write_text(str(child.pid))"
        leader = self.start(code)
        descendant = int(wait(lambda: output.read_text()))
        self.pids.append(descendant)
        wait(lambda: self.request({'op': 'status', 'target': leader['id']})['status'] == 'exited')
        self.assertTrue(live(descendant))
        return leader, descendant

    def test_kill_cleans_group_after_leader_exit_without_pid_reuse(self):
        leader, descendant = self.descendant()
        # Exit observation must not reap the leader: retained PID pins the PGID.
        self.assertTrue(Path('/proc/%s' % leader['pid']).exists(), 'leader reaped before group cleanup')
        result = self.request({'op': 'kill', 'target': leader['id'], 'signal': 'SIGKILL'})
        self.assertTrue(result['ok'])
        wait(lambda: not live(descendant))
        unrelated = subprocess.Popen(['/usr/bin/python3', '-c', 'import time;time.sleep(60)'], start_new_session=True)
        try:
            self.assertTrue(self.request({'op': 'kill', 'target': leader['id'], 'signal': 'SIGKILL'})['ok'])
            self.assertIsNone(unrelated.poll())
        finally:
            unrelated.kill(); unrelated.wait()

    def test_term_escalates_for_descendant_ignoring_signal(self):
        output = self.base / 'ignore.pid'
        code = "import subprocess,pathlib; child=subprocess.Popen(['/usr/bin/python3','-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)']);pathlib.Path(" + repr(str(output)) + ").write_text(str(child.pid))"
        leader = self.start(code)
        descendant = int(wait(lambda: output.read_text()))
        self.pids.append(descendant)
        wait(lambda: self.request({'op': 'status', 'target': leader['id']})['status'] == 'exited')
        time.sleep(.1)
        self.assertTrue(self.request({'op': 'kill', 'target': leader['id'], 'signal': 'SIGTERM'})['ok'])
        wait(lambda: not live(descendant))

    def test_launcher_shutdown_cleans_group_after_leader_exit(self):
        _, descendant = self.descendant()
        self.daemon.terminate(); self.daemon.wait(timeout=5)
        wait(lambda: not live(descendant))


if __name__ == '__main__':
    if sys.platform != 'linux' or os.getuid() != 0:
        raise SystemExit('requires disposable Linux container running as root')
    unittest.main(verbosity=2)
