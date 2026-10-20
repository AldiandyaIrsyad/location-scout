"""Static dev server with caching disabled, so edited ES modules always reload.

Usage: python tools/serve.py [port]   (serves the project root)
"""
import functools
import http.server
import os
import sys

# Frontend only (no /api): the Go server (cmd/server) is the real backend; this is a static fallback.
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    # The page requests a dozen ES modules at once; the default backlog of 5 can overflow
    # on Windows and refuse one, which breaks the whole module graph for that page load.
    request_queue_size = 64
    daemon_threads = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    Server(("", port), handler).serve_forever()
