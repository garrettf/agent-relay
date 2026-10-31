# Developing agent-relay

- The mod (`claude-plugin/`) is hot-reloaded from `~/.claude/dev-mods/<session>/codex-relay`, a symlink to `claude-plugin/`.
- **Force a reload mid-turn:** after editing, call any tool the mod registers (`codex_list` is the cheap one). The engine reloads a mod edited during the turn before running one of its tools. Without that it reloads only at turn end.
- **Current bridge socket:** `jq -r .sock ~/.agent-relay/sessions/<session-id>.json`. The newest bridge owns that file. Every reload starts a new bridge with a new socket.
- **Bridge traces** (`trace()` in the mod): `curl -s --unix-socket <sock> 'http://relay/events?since=0&kind=log&timeoutMs=0'`.
- **Fake a Codex app thread messaging Claude:** `curl --unix-socket <sock> -X POST http://relay/inbound -d '{"fromThread":"t1","fromName":"x","text":"hi","awaitReply":true}'`. It holds until Claude replies to `codex:t1`. A reload drops it (exit 52).
- **Reload semantics this design depends on:**
  - The old module (and its bridge) lives on until its hooks in flight return.
  - A `turn.step` in flight is never cut, so a step that waits keeps an agent on the old module.
  - A `tool.call` in flight is cancelled at the next reload.
  - That's why the inbox waits in a tool call (`codex_inbox_wait`), not in its step.
- Type-check: `npx -y -p typescript@5.6.3 tsc -p <tsconfig naming claude-plugin/.claude-plugin/types and claude-plugin/hooks>`. Validate: `claude plugin validate claude-plugin`.
- Test Codex spawns on luna models (`gpt-6-luna`, `gpt-5.6-luna`) at low effort.
