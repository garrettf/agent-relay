"""Turn completion, pushed by App Server's turn/completed notifications.

App Server notifies a connection only about threads it started or resumed, so
a wait relies on the push for those and reconciles the rest by reading recent
turns at a slow interval (a thread this connection never touched, or one from
before a reconnect). A wait never resumes a thread to subscribe to it.
"""

import asyncio
from collections import OrderedDict
from typing import Any

TERMINAL = {"completed", "failed", "interrupted"}
RECONCILE_SECONDS = 15
RETAINED = 1000


def final_message(turn: dict[str, Any]) -> str | None:
    messages = [i for i in turn.get("items") or [] if i.get("type") == "agentMessage"]
    final = next((m for m in reversed(messages) if m.get("phase") == "final_answer"), None)
    final = final or (messages[-1] if messages else None)
    return final.get("text") if final else None


def outcome(thread_id: str, turn: dict[str, Any]) -> dict[str, Any]:
    return {
        "threadId": thread_id,
        "turnId": turn["id"],
        "status": turn.get("status"),
        "error": turn.get("error"),
        "durationMs": turn.get("durationMs"),
        "finalMessage": final_message(turn),
        "turn": turn,
    }


class TurnWatch:
    def __init__(self, rpc):
        self.rpc = rpc
        self.done: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()
        # thread ID -> the socket it was subscribed on; a reconnect drops them all.
        self._subscribed: dict[str, object] = {}
        self._tick = asyncio.Event()
        rpc.listeners.append(self._on_notification)

    def subscribed(self, thread_id: str):
        """Call after this connection's thread/start or thread/resume of `thread_id`."""
        self._subscribed[thread_id] = self.rpc._ws

    def is_subscribed(self, thread_id: str) -> bool:
        ws = self._subscribed.get(thread_id)
        return ws is not None and ws is self.rpc._ws

    def _record(self, thread_id: str, turn: dict[str, Any]):
        self.done[(thread_id, turn["id"])] = outcome(thread_id, turn)
        while len(self.done) > RETAINED:
            self.done.popitem(last=False)
        tick, self._tick = self._tick, asyncio.Event()
        tick.set()

    def _on_notification(self, message: dict[str, Any]):
        if message.get("method") != "turn/completed":
            return
        params = message.get("params") or {}
        turn = params.get("turn") or {}
        if params.get("threadId") and turn.get("id") and turn.get("status") in TERMINAL:
            self._record(params["threadId"], turn)

    async def inspect(self, thread_id: str, turn_id: str) -> dict[str, Any] | None:
        # Search recent turns only; never confuse a different completed turn with the target.
        page = await self.rpc.call(
            "thread/turns/list", {"threadId": thread_id, "limit": 100, "itemsView": "summary"}
        )
        turn = next((t for t in page["data"] if t["id"] == turn_id), None)
        if turn and turn.get("status") in TERMINAL:
            self._record(thread_id, turn)
        return turn

    async def wait(
        self, pairs: list[tuple[str, str]], seconds: float
    ) -> tuple[list[dict[str, Any]], dict[tuple[str, str], dict[str, Any] | None]]:
        """Waits until any of `pairs` (thread ID, turn ID) has ended, or `seconds` pass.

        Returns the ended outcomes and the latest observed turn of each pair.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + seconds
        latest: dict[tuple[str, str], dict[str, Any] | None] = {p: None for p in pairs}
        unchecked = set(pairs)  # every pair is read once: it may have ended before the push
        while True:
            tick = self._tick
            ended = [self.done[p] for p in pairs if p in self.done]
            if ended:
                for result in ended:
                    latest[(result["threadId"], result["turnId"])] = result["turn"]
                return ended, latest
            for pair in list(unchecked):
                latest[pair] = await self.inspect(*pair)
                if self.is_subscribed(pair[0]):
                    unchecked.discard(pair)
            if any(p in self.done for p in pairs):
                continue
            now = loop.time()
            if now >= deadline:
                return [], latest
            wake = deadline
            if unchecked:  # not pushed to this connection: read again later
                wake = min(deadline, now + RECONCILE_SECONDS)
            try:
                await asyncio.wait_for(tick.wait(), wake - now)
            except TimeoutError:
                pass
