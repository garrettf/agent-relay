# agent-relay

Claude Code → OpenAI Codex: Claude runs Codex threads on any model and effort, sees them running, and gets each turn's answer messaged back. It never impersonates the person.

`claude-plugin/` is one Claude Code plugin, `codex-relay`, with two parts:

- **`codex-thread-bridge/`** is the MCP server that does the Codex work. It's a vendored fork of [saidelike/codex-thread-bridge](https://github.com/saidelike/codex-thread-bridge) at `4b58215` (MIT).
  - It drives the shared Codex App Server daemon (`$CODEX_HOME/app-server-control/app-server-control.sock`), so threads show in the Codex app.
  - Its tools are `create_thread`, `send_message_to_thread`, `steer_thread`, `wait_thread`, `read_thread*`, `list_threads`, ….
  - **Fork changes:**
    - Waits are pushed by App Server's `turn/completed` instead of polling `thread/turns/list` (`turns.py`).
    - Model family names resolve to the newest listed model: `luna` → `gpt-6-luna`.
    - With `--events-socket`, a Unix-socket HTTP endpoint `GET /wait?turns=<thread>:<turn>,…` holds a request open until a turn ends (`events.py`). Each dispatching tool's result names that socket as `eventsSocket`.
- **`hooks/register.tsx`** is the mod: UI and delivery.
  - A band above the prompt lists each running Codex turn: model, effort, title, elapsed time, and an **Open in Codex** link (`codex://threads/<id>`). The status line shows the same.
  - Each dispatched turn gets a watcher subagent, which shows as a running task. Its wait is a single `$.http.fetch` held open by the bridge's events socket. When the turn ends, it `SendMessage`s the dispatcher (main, or the subagent that dispatched it) Codex's final answer, which wakes an idle main.
  - A prompt that names a Codex model ("kick off a luna medium subagent …") carries a note that routes it to `create_thread`, not the Agent tool.

```
Claude ─create_thread─► codex-thread-bridge (MCP) ─ws/UDS─► Codex App Server daemon
  ▲                         │ events socket                    │ turn/completed (push)
  │                         ▼                                  │
  └─SendMessage── watcher subagent ◄── $.http.fetch held ◄─────┘
```

**Why a watcher agent:** a real agent's SendMessage is the only way a mod can start a turn on an idle main conversation without writing a user-role row. MCP channels would do this natively, but Claude Desktop runs sessions in SDK mode, where channels are off.

Requires `uv`, Python ≥ 3.11 (uv fetches it), and `codex` ≥ 0.166 with its app-server daemon running. The Codex app runs it, or start it with `codex app-server daemon start`.

Install, at a Claude Code terminal prompt:

```
/plugin install codex-relay --marketplace <owner>/agent-relay
```
