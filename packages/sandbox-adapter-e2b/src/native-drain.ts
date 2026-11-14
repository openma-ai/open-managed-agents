/** Root-only per-mount RC socket. No TCP listener or credentials in argv.
 * Cold owners derive this path; the socket is a capability, not an authority
 * ledger. Existing mounts without RC must be replaced by normal bootstrap. */
export function e2bMountControlDirectory(target: string): string {
  if (!/^\/mnt\/(session\/outputs|memory\/[A-Za-z0-9_-][A-Za-z0-9._-]*)$/.test(target)) throw new Error("Unsafe E2B mount target");
  return `/run/oma-rclone/${target.slice(5).replaceAll("/", "_")}`;
}

export interface E2BDrainMount { target: string; remote: string; endpoint: string }

/** rclone fsync only saves local VFS cache (vfscache/item.go Item.Sync).
 * vfs/queue includes in-flight/retrying uploads; writeback removes an entry
 * only after putFn succeeds. This probes the actual daemon and waits for that
 * queue PLUS diskCache counters, not for a guessed upload delay. */
export function e2bNativeDrainCommand(mounts: readonly E2BDrainMount[]): string {
  const spec = mounts.map(m => ({ ...m, socket: `${e2bMountControlDirectory(m.target)}/rc.sock` }));
  return `python3 - <<'OMA_RCLONE_DRAIN_V1'\n${E2B_NATIVE_DRAIN_PYTHON}\nmain(${JSON.stringify(spec)})\nOMA_RCLONE_DRAIN_V1`;
}

export const E2B_NATIVE_DRAIN_PYTHON = String.raw`
import os, stat, json, socket, http.client, time, re
class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=5)
        self.path = path
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)
def rc(m, endpoint, values):
    c = UnixHTTP(m['socket'])
    try:
        c.request('POST', '/'+endpoint, json.dumps(values), {'Content-Type':'application/json'})
        r = c.getresponse()
        raw = r.read(1048577)
        if r.status != 200 or len(raw) > 1048576: raise RuntimeError('rclone RC unavailable: '+endpoint)
        result = json.loads(raw)
        if not isinstance(result, dict): raise RuntimeError('invalid RC result')
        return result
    finally: c.close()
def check(m):
    for p in ['/run/oma-rclone', os.path.dirname(m['socket'])]:
        st = os.lstat(p)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077: raise RuntimeError('untrusted RC directory')
    st = os.lstat(m['socket'])
    if not stat.S_ISSOCK(st.st_mode) or st.st_uid != 0: raise RuntimeError('untrusted RC socket')
    # /proc/self/mountinfo exposes the kernel mount, not an agent file.
    found = False
    for line in open('/proc/self/mountinfo'):
        a, b = line.rstrip().split(' - ', 1)
        fields, fs = a.split(), b.split()
        if fields[4] == m['target'] and fs[0] == 'fuse.rclone' and same_remote(fs[1], m['remote']): found = True
    if not found: raise RuntimeError('exact rclone mount missing')
    # Verify root-owned daemon arguments bind this socket to this mount/remote.
    daemon = None
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try:
            args = open('/proc/'+pid+'/cmdline','rb').read().decode().rstrip('\0').split('\0')
            if os.stat('/proc/'+pid).st_uid == 0 and os.path.basename(args[0]) == 'rclone' and 'mount' in args and m['target'] in args and m['remote'] in args and '--rc-addr=unix://'+m['socket'] in args:
                if daemon is not None: raise RuntimeError('ambiguous rclone daemon')
                environ = dict(x.split('=',1) for x in open('/proc/'+pid+'/environ','rb').read().decode().split('\0') if '=' in x)
                if environ.get('RCLONE_S3_ENDPOINT') != m['endpoint']: raise RuntimeError('rclone endpoint mismatch')
                daemon = pid
        except (FileNotFoundError, ProcessLookupError): continue
    if daemon is None: raise RuntimeError('bound rclone daemon missing')
    # Unclosed writers may not yet appear in the upload queue. They are not a
    # drained turn; refuse instead of fsyncing only the cache and reporting 0.
    for pid in os.listdir('/proc'):
        if not pid.isdigit() or pid == daemon: continue
        try:
            for fd in os.listdir('/proc/'+pid+'/fd'):
                path = '/proc/'+pid+'/fd/'+fd
                try:
                    target = os.readlink(path)
                    if target.startswith(m['target']+'/'):
                        info = open('/proc/'+pid+'/fdinfo/'+fd).read()
                        flags = int(next(x.split()[1] for x in info.splitlines() if x.startswith('flags:')), 8)
                        if flags & 3: raise RuntimeError('mount still has an open writer')
                except (FileNotFoundError, ProcessLookupError): continue
        except (FileNotFoundError, ProcessLookupError): continue
    start = open('/proc/'+daemon+'/stat').read().rsplit(') ', 1)[1].split()[19]
    return daemon+':'+start
def same_remote(actual, expected):
    # rclone ConfigString adds {config-hash} for environment overrides.
    # Exact root/backend plus root-owned argv+endpoint establish identity.
    return isinstance(actual, str) and re.sub(r'^:s3\{[A-Za-z0-9_-]+\}:', ':s3:', actual) == expected
def observe(m):
    s = rc(m, 'vfs/stats', {})
    if not same_remote(s.get('fs'), m['remote']): raise RuntimeError('RC remote mismatch')
    d = s.get('diskCache')
    if not isinstance(d, dict): raise RuntimeError('VFS cache stats unsupported')
    for key in ['uploadsQueued','uploadsInProgress','erroredFiles']:
        if type(d.get(key)) is not int or d[key] < 0: raise RuntimeError('incomplete VFS stats')
    if type(d.get('outOfSpace')) is not bool or d['outOfSpace'] or d['erroredFiles']: raise RuntimeError('VFS cache error')
    q = rc(m, 'vfs/queue', {}).get('queue')
    if not isinstance(q, list): raise RuntimeError('VFS queue unsupported')
    for item in q:
        if type(item.get('id')) is not int or type(item.get('uploading')) is not bool: raise RuntimeError('invalid VFS queue entry')
    return d, q
def main(mounts):
    identities = [check(m) for m in mounts]
    # Probe every mount before doing any queue mutation. Old templates without
    # RC/queue support fail here with a concrete capability error.
    for m in mounts: observe(m)
    deadline = time.monotonic()+45
    for m, identity in zip(mounts, identities):
        expedited = set()
        while True:
            if check(m) != identity: raise RuntimeError('rclone daemon changed')
            d, q = observe(m)
            if not q and d['uploadsQueued'] == 0 and d['uploadsInProgress'] == 0: break
            for item in q:
                if not item['uploading'] and item['id'] not in expedited:
                    rc(m, 'vfs/queue-set-expiry', {'id':item['id'], 'expiry':-1000000000})
                    expedited.add(item['id'])
            if time.monotonic() >= deadline: raise RuntimeError('rclone upload drain timeout')
            time.sleep(0.1) # polling cadence only; success requires explicit state
    for m, identity in zip(mounts, identities):
        if check(m) != identity: raise RuntimeError('rclone daemon changed')
        d, q = observe(m)
        if q or d['uploadsQueued'] or d['uploadsInProgress']: raise RuntimeError('rclone writes resumed')
    print(json.dumps({'type':'drained','version':1}))
`;
