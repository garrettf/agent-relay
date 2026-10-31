#!/usr/bin/env node
// Codex Stop / UserPromptSubmit hook: hands Claude's undelivered messages for
// this thread to the model. Stop blocks once with them as the continuation
// prompt; UserPromptSubmit adds them as context. Silent when there are none.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
const threadId = input.session_id
if (!threadId) process.exit(0)

const home = process.env.AGENT_RELAY_HOME || path.join(os.homedir(), '.agent-relay')
const file = path.join(home, 'mailbox', `${threadId.replace(/[^\w.-]/g, '_')}.jsonl`)
let text
try {
  text = fs.readFileSync(file, 'utf8')
  fs.rmSync(file)
} catch {
  process.exit(0)
}
const msgs = text
  .split('\n')
  .filter(Boolean)
  .map(l => JSON.parse(l))
if (!msgs.length) process.exit(0)

const body =
  'Messages from Claude Code arrived (via claude-relay):\n\n' +
  msgs.map(m => `[from ${m.from}]\n${m.text}`).join('\n\n') +
  '\n\nReply with the claude_send tool if a reply is needed.'

if (input.hook_event_name === 'Stop') {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: body }))
} else {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: body } }),
  )
}
