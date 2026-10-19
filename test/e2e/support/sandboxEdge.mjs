#!/usr/bin/env node
/**
 * The e2e-full stand-in for the wildcard sandbox Ingress: terminates TLS for
 * `*.<sandbox domain>` and forwards HTTP and WebSocket upgrades, Host intact, to the
 * conversation-router's sandbox listener (a port-forward of svc/agent-host:8081).
 * The browser reaches it through Chromium's --host-resolver-rules (playwright.config.ts),
 * so the specs open the same https://<label>.<domain>/<service>/ URLs as production.
 *
 * usage: sandboxEdge.mjs <listen port> <upstream host:port> <cert.pem> <key.pem>
 */
import https from "node:https";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";

const [port, upstream, certFile, keyFile] = process.argv.slice(2);
if (!port || !upstream || !certFile || !keyFile) {
  console.error("usage: sandboxEdge.mjs <port> <upstream host:port> <cert.pem> <key.pem>");
  process.exit(2);
}
const [upHost, upPort] = [upstream.slice(0, upstream.lastIndexOf(":")), Number(upstream.slice(upstream.lastIndexOf(":") + 1))];

// What an ingress adds; the router's sandbox listener must not care either way.
const forwarded = (req) => ({ ...req.headers, "x-forwarded-proto": "https", "x-forwarded-host": req.headers.host ?? "" });

const server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, (req, res) => {
  const up = http.request(
    { host: upHost, port: upPort, method: req.method, path: req.url, headers: forwarded(req) },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`sandbox edge: ${e.message}\n`);
  });
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  const up = net.connect(upPort, upHost, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(forwarded(req))) {
      for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
    }
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => {
    up.destroy();
    socket.destroy();
  };
  up.on("error", close);
  socket.on("error", close);
});

server.listen(Number(port), "127.0.0.1", () => console.log(`sandbox edge on https://127.0.0.1:${port} -> ${upstream}`));
