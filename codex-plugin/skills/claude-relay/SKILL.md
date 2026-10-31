---
name: claude-relay
description: Talk to Claude Code sessions running on this machine — ask Claude a question and wait for the answer, hand it a task, or message one of its subagents. Use when the user mentions Claude, Claude Code, or asks to coordinate with another agent.
---

# Talking to Claude Code

Claude Code sessions with the `codex-relay` mod loaded are reachable through the `claude_relay` MCP tools.

- `claude_sessions` — who is reachable: each session (id prefix, label, cwd) and the agents inside it (`main`, Claude subagents, Codex subagents it spawned).
- `claude_send` — send a message. By default it **blocks until Claude replies** and returns the reply.
  - `session`: needed only when several sessions are running.
  - `to`: an agent name inside that session; omit for its main conversation.
  - `name`: how you introduce yourself (e.g. `codex: auth refactor`).
  - `wait_for_reply: false` for fire-and-forget; replies then arrive in `claude_inbox`, or are handed to you when your turn ends.
- `claude_inbox` — read Claude's messages that haven't reached you yet.

Claude sees none of your conversation. Write messages that stand alone: what you need, the relevant paths, and what a good answer looks like.
