"""
proxy_server.py — Servidor local con proxy CORS para el Visor Archena
Sirve los archivos estaticos del visor Y actua de proxy para el OGC API
de Mergin Maps, anadiendo cabeceras CORS.

Uso: python proxy_server.py [puerto]
Por defecto: http://localhost:3000
"""

import http.server
import socketserver
import urllib.request
import urllib.parse
import urllib.error
import json
import os
import sys
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3000

OGC_BASE = "https://app.merginmaps.com/v2/ogc/UpOZfUR3b1gCNrvQHxFXTGaIwfo/api"
PROXY_PREFIX = "/ogc-proxy"

STATIC_DIR = Path(__file__).parent

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
}

CORS_HEADERS = [
    ("Access-Control-Allow-Origin",  "*"),
    ("Access-Control-Allow-Methods", "GET, OPTIONS"),
    ("Access-Control-Allow-Headers", "Content-Type, Accept"),
]


class ProxyHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print("  [%s] %s" % (self.address_string(), fmt % args))

    def _send_cors(self):
        for k, v in CORS_HEADERS:
            self.send_header(k, v)

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path   = parsed.path
        query  = parsed.query

        # ── Proxy al OGC API ─────────────────────────────────────────
        if path.startswith(PROXY_PREFIX):
            # /ogc-proxy/collections?limit=500  →  OGC_BASE/collections?limit=500
            ogc_path = path[len(PROXY_PREFIX):].lstrip("/")
            upstream_url = OGC_BASE + ("/" + ogc_path if ogc_path else "")
            if query:
                upstream_url += "?" + query

            print("  -> PROXY: %s" % upstream_url)

            try:
                req = urllib.request.Request(
                    upstream_url,
                    headers={
                        "Accept":     "application/json, application/geo+json",
                        "User-Agent": "VisorArchena/1.0",
                    }
                )
                with urllib.request.urlopen(req, timeout=45) as resp:
                    ct   = resp.headers.get("Content-Type", "application/json")
                    body = resp.read()

                self.send_response(200)
                self.send_header("Content-Type", ct)
                self.send_header("Content-Length", str(len(body)))
                self._send_cors()
                self.end_headers()
                self.wfile.write(body)

            except urllib.error.HTTPError as exc:
                body = exc.read() or b""
                self.send_response(exc.code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self._send_cors()
                self.end_headers()
                self.wfile.write(body)

            except Exception as exc:
                msg = json.dumps({"error": str(exc)}).encode()
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(msg)))
                self._send_cors()
                self.end_headers()
                self.wfile.write(msg)
            return

        # ── Archivos estaticos ────────────────────────────────────────
        if path in ("/", ""):
            path = "/index.html"

        file_path = STATIC_DIR / path.lstrip("/")

        if not file_path.exists() or not file_path.is_file():
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"404 Not Found")
            return

        ext          = file_path.suffix.lower()
        content_type = MIME_TYPES.get(ext, "application/octet-stream")

        with open(file_path, "rb") as f:
            body = f.read()

        self.send_response(200)
        self.send_header("Content-Type",   content_type)
        self.send_header("Content-Length", str(len(body)))
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)


# Servidor multi-hilo para no bloquear con peticiones lentas al OGC API
class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    os.chdir(STATIC_DIR)
    with ThreadedHTTPServer(("", PORT), ProxyHandler) as httpd:
        print("+=====================================================+")
        print("|  Visor Cartografico Archena - Servidor local        |")
        print("|  http://localhost:%-5d                             |" % PORT)
        print("|  Proxy OGC API activo en /ogc-proxy/                |")
        print("|  Ctrl+C para detener                                |")
        print("+=====================================================+")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Servidor detenido.")
