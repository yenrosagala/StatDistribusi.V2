"""HTTP wrapper around export_bridge.py.

The Node app normally spawns export_bridge.py directly. Some sandboxes block
child-process creation entirely (`spawn EPERM`), so Node can instead POST here
and receive the identical bytes back over localhost - no process creation from
Node required.

Run:   python export_service.py [port]        (default 8765)
Then:  EXPORT_SERVICE_URL=http://127.0.0.1:8765 node server.js

Routes:
    GET  /health   -> {"ok": true, "builders": [...]}
    POST /export   -> body {"kind": ..., "payload": {...}} -> binary file
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
import export_bridge  # noqa: E402  (chdir + sys.path setup happens in the module)

MIME = {
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx-transport": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsx-pariwisata": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "idml-transport": "application/zip",
    "idml-pariwisata": "application/zip",
}


def _log(msg):
    """Logging must never kill a request: if the parent's pipe is gone (orphaned
    process), writing to stderr raises BrokenPipeError."""
    try:
        print(msg, file=sys.stderr, flush=True)
    except Exception:
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        _log("[export-service] " + (fmt % args))

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send_json(200, {"ok": True, "builders": sorted(export_bridge.BUILDERS)})
        return self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/export":
            return self._send_json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            return self._send_json(400, {"error": "payload JSON tidak valid: %s" % exc})

        kind = req.get("kind")
        payload = req.get("payload") or {}
        builder = export_bridge.BUILDERS.get(kind)
        if not builder:
            return self._send_json(400, {"error": "Jenis ekspor tidak dikenal: %s" % kind})

        try:
            data = builder(payload)
        except Exception as exc:
            return self._send_json(500, {"error": "%s: %s" % (type(exc).__name__, exc)})

        self.send_response(200)
        self.send_header("Content-Type", MIME.get(kind, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        _log("[export-service] %s %d bytes" % (kind, len(data)))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

    # allow_reuse_address defaults to True in HTTPServer, which on Windows lets
    # several instances bind the same port and silently split connections
    # (symptom: "empty reply from server"). Refuse a second bind instead.
    class SingleBind(ThreadingHTTPServer):
        allow_reuse_address = False
        daemon_threads = True

    try:
        server = SingleBind(("127.0.0.1", port), Handler)
    except OSError as exc:
        print("[export-service] tidak bisa bind 127.0.0.1:%d (%s) - mungkin sudah berjalan."
              % (port, exc), file=sys.stderr, flush=True)
        raise SystemExit(1)

    _log("[export-service] listening on http://127.0.0.1:%d" % port)
    server.serve_forever()


if __name__ == "__main__":
    main()
