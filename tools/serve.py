#!/usr/bin/env python3
"""Local dev server that never lets the browser cache files, so a normal refresh
always shows your latest edits.

    python3 tools/serve.py          # http://localhost:8000
    python3 tools/serve.py 8080     # other port
"""
import functools, http.server, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, *args):
        pass


handler = functools.partial(NoCache, directory=ROOT)
print(f"serving {ROOT} at http://localhost:{PORT}  (ctrl+c to stop)")
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler).serve_forever()
