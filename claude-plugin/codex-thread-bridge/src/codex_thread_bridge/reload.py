"""Confirm and request an MCP configuration reload from the running App Server."""

import argparse
import asyncio
import os
import sys
from pathlib import Path
from typing import Any

from .rpc import AppServer, RpcError, TransportError


async def request_reload(socket: Path) -> dict[str, Any]:
    server = AppServer(socket)
    try:
        return await server.call("config/mcpServer/reload", None)
    finally:
        await server.close()


def main(argv: list[str] | None = None) -> int:
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--socket",
        type=Path,
        default=codex_home / "app-server-control/app-server-control.sock",
        help="Existing App Server Unix WebSocket socket",
    )
    args = parser.parse_args(argv)
    try:
        answer = input(f"Reload MCP servers via {args.socket}? [y/N]: ")
    except (EOFError, KeyboardInterrupt):
        answer = ""
    if answer.strip().lower() not in {"y", "yes"}:
        print("Cancelled; no reload request sent.")
        return 1

    try:
        result = asyncio.run(request_reload(args.socket))
    except RpcError as error:
        print(f"App Server rejected MCP reload: {error}", file=sys.stderr)
        return 2
    except OSError as error:
        print(f"Could not connect to App Server: {error}", file=sys.stderr)
        return 2
    except TransportError as error:
        print(f"MCP reload outcome unknown; do not retry blindly: {error}", file=sys.stderr)
        return 3
    if not isinstance(result, dict):
        print(
            "MCP reload outcome unknown; App Server returned an invalid response.", file=sys.stderr
        )
        return 3
    print("App Server accepted MCP reload; refresh queued for loaded tasks.")
    print("Verify the new tool inventory in a fresh task before the live steering test.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
