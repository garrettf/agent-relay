"""A local HTTP endpoint for turn completion, over a private Unix socket.

For a client that cannot hold an MCP call open while it waits (a Claude Code
mod reaches it with `$.http.fetch(..., { socketPath })`):

    GET /wait?turns=<threadId>:<turnId>,...&timeoutMs=<ms>
      -> {"ended": [{threadId, turnId, status, error, durationMs, finalMessage}]}

It answers as soon as any listed turn ends (pushed by App Server), or with an
empty list at the timeout. A client that disconnects ends its wait.
"""

import asyncio
import contextlib
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

MAX_TIMEOUT_MS = 10 * 60_000


class EventsServer:
    def __init__(self, bridge, path: Path):
        self.bridge = bridge
        self.path = path
        self._server: asyncio.AbstractServer | None = None

    async def start(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with contextlib.suppress(FileNotFoundError):
            self.path.unlink()
        self._server = await asyncio.start_unix_server(self._handle, path=str(self.path))
        os.chmod(self.path, 0o600)

    async def close(self):
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await self._server.wait_closed()
        with contextlib.suppress(FileNotFoundError):
            self.path.unlink()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            method, target, _ = head.split(b"\r\n", 1)[0].decode().split(" ", 2)
            status, body = await self._route(method, target, reader)
        except Exception as error:  # a malformed request or an App Server failure
            status, body = 500, {"error": f"{type(error).__name__}: {error}"}
        if status is None:
            writer.close()
            return
        data = json.dumps(body).encode()
        reason = {200: "OK", 400: "Bad Request", 404: "Not Found"}.get(status, "Error")
        with contextlib.suppress(ConnectionError):
            writer.write(
                f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode()
                + data
            )
            await writer.drain()
        writer.close()

    async def _route(self, method: str, target: str, reader: asyncio.StreamReader):
        url = urlsplit(target)
        if method != "GET" or url.path != "/wait":
            return 404, {"error": f"no route {method} {url.path}"}
        query = parse_qs(url.query)
        pairs = []
        for spec in ",".join(query.get("turns", [])).split(","):
            thread_id, sep, turn_id = spec.partition(":")
            if not sep or not thread_id or not turn_id:
                return 400, {"error": f"turns: expected threadId:turnId, got {spec!r}"}
            pairs.append((thread_id, turn_id))
        timeout_ms = min(int(query.get("timeoutMs", ["30000"])[0]), MAX_TIMEOUT_MS)
        wait = asyncio.ensure_future(self.bridge.wait_turns(pairs, timeout_ms / 1000))
        hangup = asyncio.ensure_future(reader.read(1))  # b"" once the client goes away
        done, _ = await asyncio.wait({wait, hangup}, return_when=asyncio.FIRST_COMPLETED)
        if wait not in done:
            wait.cancel()
            return None, None
        hangup.cancel()
        return 200, {"ended": wait.result()}
