"""Fake GitHub and GitLab over TLS that log every credential received."""

import base64
import json
import os
import ssl
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.environ["FORGE_ROOT"]
LOG = os.environ["FORGE_LOG"]
GITHUB_TOKEN = os.environ["GITHUB_TOKEN"]
GITLAB_TOKEN = os.environ["GITLAB_TOKEN"]
# Git host -> (basic-auth user, token) the broker should send.
GIT = {"github.com": ("x-access-token", GITHUB_TOKEN), "gitlab.com": ("oauth2", GITLAB_TOKEN)}
# API host -> (path, token, body).
API = {
    "api.github.com": ("/user", GITHUB_TOKEN, {"login": "forge-test"}),
    "gitlab.com": ("/api/v4/user", GITLAB_TOKEN, {"username": "forge-test"}),
}
_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self._serve()

    def do_POST(self):
        self._serve()

    def _body(self) -> bytes:
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            out = b""
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip(), 16)
                if size == 0:
                    self.rfile.readline()
                    return out
                out += self.rfile.read(size)
                self.rfile.readline()
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def _send(self, status, body=b"", headers=()):
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve(self):
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        path, _, query = self.path.partition("?")
        auth = self.headers.get("Authorization") or ""
        body = self._body()
        with _lock, open(LOG, "a") as f:
            f.write(json.dumps({
                "method": self.command, "host": host, "path": path, "query": query, "authorization": auth,
                "private_token": self.headers.get("Private-Token") or "",
            }) + "\n")

        if host in API and path == API[host][0]:
            token = API[host][1]
            # GitHub sends a bearer token, GitLab a PRIVATE-TOKEN header.
            if auth != f"Bearer {token}" and self.headers.get("Private-Token") != token:
                return self._send(401, b'{"message":"Bad credentials"}', [("Content-Type", "application/json")])
            return self._send(200, json.dumps(API[host][2]).encode(), [("Content-Type", "application/json")])

        if host in GIT and ".git/" in path:
            user, token = GIT[host]
            if auth != "Basic " + base64.b64encode(f"{user}:{token}".encode()).decode():
                return self._send(401, b"bad credentials", [("WWW-Authenticate", 'Basic realm="fake-forge"')])
            return self._git(host, path, query, body, user)

        if host == "other.test":
            return self._send(200, b"direct\n")
        return self._send(404, b'{"message":"Not Found"}', [("Content-Type", "application/json")])

    def _git(self, host, path, query, body, user):
        env = {
            "PATH": os.environ["PATH"],
            "GIT_PROJECT_ROOT": os.path.join(ROOT, host),
            "GIT_HTTP_EXPORT_ALL": "1",
            "PATH_INFO": path,
            "QUERY_STRING": query,
            "REQUEST_METHOD": self.command,
            "CONTENT_TYPE": self.headers.get("Content-Type") or "",
            "CONTENT_LENGTH": str(len(body)),
            "HTTP_CONTENT_ENCODING": self.headers.get("Content-Encoding") or "",
            "GIT_PROTOCOL": self.headers.get("Git-Protocol") or "",
            # Any REMOTE_USER makes http-backend allow receive-pack.
            "REMOTE_USER": user,
            "REMOTE_ADDR": self.client_address[0],
        }
        out = subprocess.run(["git", "http-backend"], input=body, env=env, capture_output=True, check=False).stdout
        sep = out.find(b"\r\n\r\n")
        head, rest = (out[:sep], out[sep + 4:]) if sep >= 0 else out.split(b"\n\n", 1)
        status, headers = 200, []
        for line in head.decode("latin-1").splitlines():
            k, _, v = line.partition(":")
            if k.lower() == "status":
                status = int(v.split()[0])
            elif k:
                headers.append((k, v.strip()))
        self._send(status, rest, headers)


def main():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(os.environ["TLS_CERT"], os.environ["TLS_KEY"])
    server = ThreadingHTTPServer(("0.0.0.0", 443), Handler)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
