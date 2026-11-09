# Local stand-in for Apache+PHP: serves static files and mimics api.php. Usage: python3 dev_server.py [port]
import json, os, re, sys, uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(ROOT, 'db')

def versions(d):
    return sorted(int(f[:-5]) for f in os.listdir(d) if f.endswith('.json')) if os.path.isdir(d) else []

class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)

    def reply(self, code, body, headers={}):
        self.send_response(code); self.send_header('Content-Type', 'application/json')
        for k, v in headers.items(): self.send_header(k, str(v))
        self.end_headers()
        self.wfile.write(body.encode() if isinstance(body, str) else body)

    def id(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        id = q.get('id', [''])[0]
        return u.path, q, id, (id == '' or re.fullmatch(r'[0-9a-f-]{36}', id))

    def do_GET(self):
        path, q, id, ok = self.id()
        if path.startswith('/db/'): return self.reply(403, '{"error":"forbidden"}')
        if path != '/api.php': return super().do_GET()
        d = os.path.join(DB, id)
        vs = versions(d) if ok and id else []
        if not vs: return self.reply(404, '{"error":"not found"}')
        v = int(q['v'][0]) if 'v' in q else vs[-1]
        f = os.path.join(d, f'{v}.json')
        if not os.path.isfile(f): return self.reply(404, '{"error":"version not found"}')
        self.reply(200, open(f, 'rb').read(), {'X-Version': v, 'X-Latest-Version': vs[-1]})

    def do_POST(self):
        path, q, id, ok = self.id()
        if path != '/api.php' or not ok: return self.reply(400, '{}')
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        json.loads(body)
        id = id or str(uuid.uuid4())
        d = os.path.join(DB, id)
        os.makedirs(d, exist_ok=True)
        v = (versions(d) or [0])[-1] + 1
        open(os.path.join(d, f'{v}.json'), 'xb').write(body)
        self.reply(200, json.dumps({'id': id, 'v': v}))

ThreadingHTTPServer(('0.0.0.0', int(sys.argv[1]) if len(sys.argv) > 1 else 8340), H).serve_forever()
