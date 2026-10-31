import argparse
import json
import os
import re
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
PROBES = ROOT / 'probes'
FEEDBACK = ROOT / 'feedback.json'
LOCK = threading.Lock()
KEY = re.compile(r'^[a-z0-9][a-z0-9-]{0,79}$')

def read_feedback():
    if not FEEDBACK.exists():
        return {}
    value = json.loads(FEEDBACK.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError('invalid feedback data')
    return value

class Handler(SimpleHTTPRequestHandler):
    def guess_type(self, path):
        kind = super().guess_type(path)
        return 'text/html; charset=utf-8' if kind == 'text/html' else kind

    def send_json(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlparse(self.path).path == '/api/feedback':
            try:
                with LOCK:
                    data = read_feedback()
                self.send_json(200, data)
            except (OSError, ValueError):
                self.send_json(500, {'error': '의견을 불러오지 못했어요'})
            return
        if urlparse(self.path).path == '/':
            self.path = '/hub.html'
        return super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path != '/api/feedback':
            self.send_json(404, {'error': 'not found'})
            return
        expected = f'http://127.0.0.1:{self.server.server_port}'
        if self.headers.get('Origin') != expected or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.send_json(403, {'error': 'forbidden'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 32768:
                raise ValueError('invalid length')
            obj = json.loads(self.rfile.read(length))
            key, value = obj['key'], obj['value']
            if not isinstance(key, str) or not KEY.fullmatch(key) or not isinstance(value, dict):
                raise ValueError('invalid feedback')
            with LOCK:
                data = read_feedback()
                data[key] = value
                temp = FEEDBACK.with_suffix('.tmp')
                temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                os.replace(temp, FEEDBACK)
            self.send_json(200, {'ok': True})
        except (OSError, ValueError, KeyError, TypeError):
            self.send_json(400, {'error': '의견을 저장하지 못했어요'})

def main():
    parser = argparse.ArgumentParser(description='PIKKU local design preview')
    parser.add_argument('--port', type=int, default=4176)
    args = parser.parse_args()
    handler = partial(Handler, directory=str(PROBES))
    with ThreadingHTTPServer(('127.0.0.1', args.port), handler) as server:
        print(f'PIKKU preview: http://127.0.0.1:{server.server_port}/', flush=True)
        server.serve_forever()

if __name__ == '__main__':
    main()
