
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("PORT", "9090"))
SEEN = []


class H(BaseHTTPRequestHandler):
    def _json(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/healthz":
            return self._json(200, {"ok": True})
        if self.path == "/__seen":
            return self._json(200, SEEN)
        self._json(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        req = json.loads(self.rfile.read(n) or b"{}")
        # Record that a call arrived with the auth we were given, since the test asserts
        # the agent-host attached the SA token rather than forwarding the container's.
        SEEN.append({"method": req.get("method"),
                     "authorization": self.headers.get("authorization")})
        m = req.get("method")
        if m == "initialize":
            return self._json(200, {"jsonrpc": "2.0", "id": req.get("id"),
                                    "result": {"protocolVersion": "2024-11-05",
                                               "capabilities": {"tools": {}},
                                               "serverInfo": {"name": "fake-broker", "version": "0"}}})
        if m == "tools/list":
            return self._json(200, {"jsonrpc": "2.0", "id": req.get("id"),
                                    "result": {"tools": [
                                        {"name": "github_create_pr",
                                         "description": "the contrib tool the agent could not see",
                                         "inputSchema": {"type": "object"}}]}})
        # The SDK probes optional methods and relies on a rejection.
        self._json(200, {"jsonrpc": "2.0", "id": req.get("id"),
                         "error": {"code": -32601, "message": "method not found"}})

    def log_message(self, *a):
        sys.stderr.write("fake-broker: " + (a[0] % a[1:]) + "\n")


HTTPServer(("0.0.0.0", PORT), H).serve_forever()
