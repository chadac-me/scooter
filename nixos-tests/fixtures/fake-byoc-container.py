import asyncio
import base64
import json
import os
import sys
import time
import uuid
import websockets

# Act as a BYOC container doing MCP for real: attach, take the offer, then open a
# tunnel stream per MCP request and read chunk frames back until close, the path
# where a CONNECT_TIMEOUT or a refused target shows up.

CONCURRENCY = int(os.environ.get("FAKE_CONCURRENCY", "1"))
SESSION_N = 0


def acp_result(frame_type, payload):
    global SESSION_N
    if frame_type == "initialize":
        return {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}
    if frame_type in ("new_session", "newSession"):
        p = (payload or {}).get("params") or (payload or {})
        SESSION_N += 1
        return {"sessionId": p.get("sessionId") or f"acp-session-{SESSION_N}"}
    if frame_type == "prompt":
        return {"stopReason": "end_turn"}
    return {}


def decode_chunk(payload):
    data = (payload or {}).get("data")
    if not isinstance(data, str):
        return b""
    for dec in (lambda d: base64.b64decode(d), lambda d: bytes.fromhex(d)):
        try:
            return dec(data)
        except Exception:
            continue
    return data.encode()


async def mcp_call(ws, target, method, streams, timeout):
    """One MCP request over its own tunnel stream, returning the parsed JSON-RPC reply or a dict describing the failure (a timeout is a finding, so it never raises)."""
    sid = f"mcp-{uuid.uuid4()}"
    # initialize requires a real params object; empty params gets -32603 from the
    # scooter-env endpoint.
    params = {}
    if method == "initialize":
        params = {"protocolVersion": "2024-11-05",
                  "capabilities": {},
                  "clientInfo": {"name": "nixos-test-container", "version": "0"}}
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    fut = asyncio.get_event_loop().create_future()
    streams[sid] = {"fut": fut, "buf": b"", "closed": None}
    started = time.monotonic()
    await ws.send(json.dumps({
        "ch": "tunnel", "type": "open", "id": sid,
        "payload": {"target": target, "method": "POST", "path": "/mcp",
                    "headers": {"content-type": "application/json",
                                "accept": "application/json, text/event-stream",
                                "authorization": "Bearer CONTAINER-TOKEN"}},
    }))
    await ws.send(json.dumps({"ch": "tunnel", "type": "chunk", "id": sid,
                              "payload": {"data": base64.b64encode(body.encode()).decode()}}))
    await ws.send(json.dumps({"ch": "tunnel", "type": "end", "id": sid, "payload": {}}))
    try:
        await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        return {"method": method, "ok": False, "reason": "TIMEOUT",
                "elapsed": round(time.monotonic() - started, 2)}
    st = streams[sid]
    out = {"method": method, "elapsed": round(time.monotonic() - started, 2),
           "closed": st["closed"]}
    try:
        # scooter-broker answers plain JSON while scooter-env answers SSE as the
        # StreamableHTTP transport, and a real MCP client reads both.
        text = st["buf"].decode() or "{}"
        if text.lstrip().startswith(("event:", "data:")):
            payloads = [ln[5:].strip() for ln in text.splitlines()
                        if ln.startswith("data:")]
            text = payloads[-1] if payloads else "{}"
        out["reply"] = json.loads(text)
        out["ok"] = "result" in out["reply"]
        if not out["ok"]:
            out["reason"] = f"jsonrpc error: {out['reply'].get('error')}"
    except Exception as e:
        out["ok"] = False
        out["reason"] = f"unparseable: {e} raw={st['buf'][:200]!r}"
    return out


async def main():
    url, budget, report = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    out = {"connected": False, "initialize_seen": False, "mcp_offer": None,
           "mcp_calls": [], "acp_seen": [], "notified": [], "inflight": []}
    streams = {}

    def flush():
        with open(report, "w") as fh:
            json.dump(out, fh)

    flush()
    async with websockets.connect(url, max_size=None) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
        out["connected"] = hello.get("type") == "connected"
        flush()

        async def reader():
            while True:
                f = json.loads(await ws.recv())
                ch, ftype, fid = f.get("ch"), f.get("type"), f.get("id")

                # Tunnel replies to streams we opened.
                if ch == "tunnel" and fid in streams:
                    st = streams[fid]
                    if ftype == "chunk":
                        st["buf"] += decode_chunk(f.get("payload"))
                    elif ftype in ("close", "error"):
                        st["closed"] = f.get("payload")
                        if not st["fut"].done():
                            st["fut"].set_result(True)
                    continue

                if ch == "acp" and ftype and fid:
                    out["acp_seen"].append(ftype)
                    if ftype == "initialize":
                        out["initialize_seen"] = True
                    if ftype in ("new_session", "newSession"):
                        p = (f.get("payload") or {}).get("params") or (f.get("payload") or {})
                        offer = p.get("mcpServers") or []
                        out["mcp_offer"] = [o.get("name") for o in offer if isinstance(o, dict)]
                        out["mcp_offer_full"] = offer
                    result = acp_result(ftype, f.get("payload"))
                    if ftype == "prompt":
                        out["inflight"].append(fid)
                        flush()
                        waited = 0.0
                        while len(out["inflight"]) < CONCURRENCY and waited < 20:
                            await asyncio.sleep(0.1)
                            waited += 0.1
                        p = (f.get("payload") or {}).get("params") or (f.get("payload") or {})
                        acp_sid = p.get("sessionId")
                        if acp_sid:
                            out["notified"].append(acp_sid)
                            await ws.send(json.dumps({
                                "ch": "acp", "type": "session_update", "sid": acp_sid,
                                "payload": {"sessionId": acp_sid,
                                            "update": {"sessionUpdate": "agent_message_chunk",
                                                       "content": {"type": "text",
                                                                   "text": f"from {acp_sid}"}}},
                            }))
                    await ws.send(json.dumps({"ch": "acp", "type": "ack", "id": fid,
                                              "payload": {"result": result}}))
                    flush()

                    # Signal the driver task rather than calling MCP here, since
                    # mcp_call awaits a future only this loop can resolve.
                    if out["mcp_offer"] and not offered.done():
                        offered.set_result(True)

        offered = asyncio.get_event_loop().create_future()

        async def driver():
            """Run the MCP calls once an offer arrives, outside the reader loop."""
            await offered
            for target in out["mcp_offer"] or []:
                for method in ("initialize", "tools/list"):
                    r = await mcp_call(ws, target, method, streams, 20)
                    r["target"] = target
                    out["mcp_calls"].append(r)
                    flush()

        task = asyncio.ensure_future(reader())
        drive = asyncio.ensure_future(driver())
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=budget)
        except (asyncio.TimeoutError, Exception):
            pass
        task.cancel()
        drive.cancel()
        flush()
    print(json.dumps(out), flush=True)

asyncio.run(main())
