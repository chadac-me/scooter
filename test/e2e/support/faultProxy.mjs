/**
 * SSE fault proxy: a tiny HTTP proxy between the UI dev server and agent-host, so e2e can
 * simulate stream failures the browser cannot inject itself. Every request is forwarded,
 * but on the conversation integrity stream (`…/events.integrity`) the current fault applies:
 *   - drop(eventType) / stall(stallMs) / killAfter(n) / authExpire (401)
 *   - duplicate(eventType, n) / reorder(eventType) / garbage(afterN) / truncate(afterN)
 *     / corruptChecksum(afterN) / bogusEvent(afterN)
 * Faults are set by the test via `POST /__fault` (JSON body) and apply to the next
 * integrity connection; `{mode:"none"}` clears. Env: FAULT_PROXY_PORT (8090),
 * AGENT_HOST_PORT (8080).
 */

import http from "node:http";

const INTEGRITY_RE = /\/events\.integrity(\?|$)/;

/** Parse one SSE frame's inner event type (best-effort). */
function frameEventType(frame) {
  const line = frame.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line.slice(5).trim());
    return parsed?.event?.type;
  } catch {
    return undefined;
  }
}

export function startFaultProxy({ port, targetHost, targetPort }) {
  /** @type {{mode:string, eventType?:string, stallMs?:number, n?:number}} */
  let fault = { mode: "none" };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    // Control channel: set/clear the active fault.
    if (url === "/__fault" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          fault = body ? JSON.parse(body) : { mode: "none" };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, fault }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }

    const isIntegrity = INTEGRITY_RE.test(url);

    // authExpire: respond 401 for the stream instead of proxying.
    if (isIntegrity && fault.mode === "authExpire") {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Unauthorized (session expired)");
      return;
    }

    const proxyReq = http.request(
      { host: targetHost, port: targetPort, method: req.method, path: url, headers: req.headers },
      (proxyRes) => {
        if (!isIntegrity || fault.mode === "none") {
          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
          proxyRes.pipe(res);
          return;
        }

        // Integrity stream with a fault: re-frame the SSE body so faults apply at frame boundaries.
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        let buf = "";
        let forwarded = 0;
        let stalled = false;
        let killed = false;

        /** Frames held back by `reorder`, released after the following frame. */
        let held = null;

        const rawWrite = (text) => { res.write(text); };

        const flushFrame = (frame) => {
          if (killed) return;

          // --- Corruption modes: the stream keeps flowing but delivers wrong data ---
          if (fault.mode === "duplicate") {
            const t = frameEventType(frame);
            if (t && t === fault.eventType) {
              const extra = fault.n ?? 1;
              if (fault.once !== false) fault = { mode: "none" };
              // Deliver the frame, then re-deliver it N more times (at-least-once redelivery).
              rawWrite(frame + "\n\n");
              for (let i = 0; i < extra; i++) rawWrite(frame + "\n\n");
              forwarded += 1 + extra;
              return;
            }
          }
          if (fault.mode === "reorder") {
            const t = frameEventType(frame);
            if (held === null && t && t === fault.eventType) {
              held = frame; // hold it; the next frame goes first
              return;
            }
            if (held !== null) {
              rawWrite(frame + "\n\n");        // the later frame arrives first
              rawWrite(held + "\n\n");         // then the held one, out of order
              held = null;
              forwarded += 2;
              if (fault.once !== false) fault = { mode: "none" };
              return;
            }
          }
          if (fault.mode === "garbage" && forwarded >= (fault.afterN ?? 1)) {
            if (fault.once !== false) fault = { mode: "none" };
            // An unparseable data: line mid-stream, which the client must skip.
            rawWrite("data: {this is not json at all,,,}\n\n");
          }
          if (fault.mode === "truncate" && forwarded >= (fault.afterN ?? 1)) {
            if (fault.once !== false) fault = { mode: "none" };
            // A frame cut mid-JSON with no terminator, like a torn write on the wire.
            rawWrite("data: {\"kind\":\"event\",\"event\":{\"type\":\"TEXT_MES");
          }
          if (fault.mode === "bogusEvent" && forwarded >= (fault.afterN ?? 1)) {
            if (fault.once !== false) fault = { mode: "none" };
            // Well-formed JSON with an unknown event type, like a newer server talking to an older client.
            rawWrite('data: {"kind":"event","event":{"type":"TOTALLY_UNKNOWN_EVENT","weird":true}}\n\n');
          }
          if (fault.mode === "corruptChecksum" && forwarded >= (fault.afterN ?? 1)) {
            if (fault.once !== false) fault = { mode: "none" };
            // Break the integrity chain with a wrong checksum, so the client must re-sync from the server.
            const bad = frame.replace(/"checksum":"[0-9a-f]+"/, '"checksum":"' + "d".repeat(64) + '"');
            rawWrite(bad + "\n\n");
            forwarded += 1;
            return;
          }

          if (fault.mode === "drop") {
            const t = frameEventType(frame);
            if (t && t === fault.eventType) {
              // One-shot by default: drop the first matching frame and disarm, so the
              // reconnect's re-fetch heals the UI; `once:false` drops every occurrence.
              if (fault.once !== false) fault = { mode: "none" };
              return; // omit this occurrence
            }
          }
          res.write(frame + "\n\n");
          forwarded += 1;
          if (fault.mode === "killAfter" && forwarded >= (fault.n ?? 1)) {
            killed = true;
            // One-shot: disarm so the UI's reconnect gets a clean stream.
            fault = { mode: "none" };
            proxyRes.destroy(); // abrupt close; the UI must reconnect and re-fold
            res.end();
          }
        };

        const drain = () => {
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (frame.trim()) flushFrame(frame);
          }
        };

        proxyRes.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          // stall: hold the whole stream once for stallMs, then resume.
          if (fault.mode === "stall" && !stalled) {
            stalled = true;
            setTimeout(drain, fault.stallMs ?? 1000);
            return;
          }
          if (!stalled || fault.mode !== "stall") drain();
        });
        proxyRes.on("end", () => { if (!killed) res.end(); });
        proxyRes.on("error", () => { if (!killed) res.end(); });
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(proxyReq);
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const port = Number(process.env.FAULT_PROXY_PORT ?? 8090);
const targetPort = Number(process.env.AGENT_HOST_PORT ?? 8080);
startFaultProxy({ port, targetHost: "127.0.0.1", targetPort }).then(() => {
  // eslint-disable-next-line no-console
  console.log(`[fault-proxy] listening on ${port} -> 127.0.0.1:${targetPort}`);
});
