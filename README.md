# agent-relay

Claude Code ⇄ OpenAI Codex, both directions.

- **`claude-plugin/` — `codex-relay`** (Claude Code mod). Claude spawns Codex threads as real subagents on any Codex model + reasoning effort, messages them mid-turn, and gets messaged back.
- **`codex-plugin/` — `claude-relay`** (Codex plugin). Any Codex thread (Codex app, CLI, IDE) can list running Claude sessions, message them, and block on Claude's reply.

## How it works

```
Claude session ─ codex-relay mod ─HTTP/UDS─► relay-bridge.mjs ─stdio JSON-RPC─► codex app-server
   ▲   ▲            turn.step answered           │  ▲                               (subagent threads)
   │   │            by the mod                   │  │ /inbound (held until reply)
   │   └─ SendMessage ◄─ Codex subagent          │  └── claude-relay MCP ◄── Codex app / CLI thread
   └───── SendMessage ◄─ codex-inbox (one per session, all external threads)
```

- A Codex subagent is a Claude subagent whose model steps the mod answers by driving a Codex thread (`thread/start`, `turn/start`), streaming Codex's messages back as the step's text and its commands/edits as (unrecorded) thinking. So it shows in the task list, its answer returns like any agent's, and SendMessage reaches it.
- Claude → running Codex turn: `turn/steer` (lands mid-turn). Claude → finished Codex subagent: the engine resumes the agent, which runs a new Codex turn.
- Codex → Claude never impersonates the person: every message reaches Claude as a real `SendMessage` from a subagent's own loop, which the mod emits as that subagent's tool use.
  - Codex subagents: app-server *dynamic tools* (`claude_send`, `claude_agents`). A `claude_send` call ends the subagent's step with a SendMessage; its result is the tool's answer.
  - Other Codex threads (Codex app, CLI): the `claude-relay` MCP server posts to the session's bridge and by default blocks for the reply. The session's `codex-inbox` subagent relays it as its own SendMessage; Claude answers with SendMessage to `codex:<threadId>`, which resolves the blocked call.
  - The inbox runs for the whole session: only an agent spawned from inside a hook gets the mod's `turn.step`, so it starts in `session.start` / `session.attach`, and `turn.start` restarts it if it ended. Its idle wait is a tool call (`codex_inbox_wait`), so a mod reload hands it to the new module. In a headless run (no surface) there's no inbox and inbound messages fail fast.
  - Late replies go to `~/.agent-relay/mailbox/<thread>.jsonl`, drained by `claude_inbox` and the plugin's `Stop`/`UserPromptSubmit` hooks.
- Model + effort are resolved at spawn (spawn args → mod options → Codex `config.toml` → the model's default) and shown in the task list (`[gpt-… · high] task`), the status line, `/codex`, and `codex_spawn`'s result. (The engine still labels the subagent's own transcript rows with its placeholder Claude model, `haiku`, which never runs.)
- The bridge exists because a mod's `$.process.spawn` stdin is one-shot; long waits are `$.http.fetch` long-polls so they don't burn a hook's 10 s own-time budget.

## Claude side

Tools: `codex_spawn` (prompt, model, effort, name, sandbox, cwd, wait), `codex_send`, `codex_list`, `codex_interrupt`; `/codex` shows status. SendMessage to a Codex subagent's name, or to `codex:<threadId>` for an external Codex thread, also works.

Options (`/config` → codex-relay): default model, effort, sandbox, transport (`spawn` a private app-server, or `daemon` to share the local one), node/codex paths.

Install, at a Claude Code terminal prompt:

```
/plugin install codex-relay --marketplace <owner>/agent-relay
```

## Codex side

```bash
codex plugin marketplace add /path/to/agent-relay
```

```bash
codex plugin add claude-relay@agent-relay
```

Tools: `claude_sessions`, `claude_send` (`session`, `to`, `name`, `wait_for_reply`, `timeout_sec`), `claude_inbox`.

Requires Node ≥ 18 and `codex` ≥ 0.166 (app-server with `turn/steer` and dynamic tools).
