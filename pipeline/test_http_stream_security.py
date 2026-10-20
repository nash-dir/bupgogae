"""Real requests/urllib3 decoder regressions; synthetic localhost only."""
from pathlib import Path
import subprocess
import sys
import unittest


PROBE = r'''
import http.server, threading, zlib, sys
import requests
from api import _read_bounded_body
mode = sys.argv[1]
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200)
        self.send_header('Transfer-Encoding', 'chunked')
        if mode != 'long-header': self.send_header('Content-Encoding', 'deflate')
        self.end_headers()
        if mode == 'long-header':
            self.wfile.write(b'1'*(1024*1024)+b'\r\n')
        else:
            data = zlib.compress(b'A'*131072)
            if mode == 'trailing': data += b'trailing'
            self.wfile.write(f'{len(data):x}\r\n'.encode()+data+b'\r\n0\r\n\r\n')
        self.wfile.flush()
server = http.server.HTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
session = requests.Session(); session.trust_env = False
try:
    with session.get(f'http://127.0.0.1:{server.server_port}/',stream=True,timeout=(1,1)) as r:
        data = _read_bounded_body(r)
    assert mode != 'long-header' and data == b'A'*131072
except requests.exceptions.ChunkedEncodingError as error:
    # The patch rejects the length line before buffering it without a bound.
    pending = [error]; seen = set(); names = set(); messages = set()
    while pending:
        item = pending.pop()
        if id(item) in seen: continue
        seen.add(id(item)); names.add(type(item).__name__)
        messages.update(x for x in getattr(item,'args',()) if isinstance(x,str) and len(x)<200)
        pending.extend(x for x in getattr(item,'args',()) if isinstance(x,BaseException))
        pending.extend(x for x in [getattr(item,'__cause__',None),getattr(item,'__context__',None)] if x)
    assert mode == 'long-header' and ('LineTooLong' in names or
        'Response chunk size line exceeded maximum allowed length' in messages)
finally:
    server.shutdown()
print('bounded stream passed')
'''


class HttpStreamSecurityTests(unittest.TestCase):
    def test_real_decoder_terminates_on_trailing_deflate_and_long_chunk_header(self):
        for mode in ["normal", "trailing", "long-header"]:
            with self.subTest(mode=mode):
                result = subprocess.run(
                    [sys.executable, "-c", PROBE, mode],
                    cwd=Path(__file__).resolve().parent, capture_output=True,
                    text=True, timeout=8,
                )
                self.assertEqual(result.returncode, 0, result.stderr[-1500:])


if __name__ == "__main__":
    unittest.main()
