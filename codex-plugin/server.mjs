#!/usr/bin/env node
// claude-relay MCP server: lets a Codex thread (Codex app, CLI, or IDE) talk
// to running Claude Code sessions that have the codex-relay mod loaded.
//
// Each such session runs a relay bridge that registers itself under
// ~/.agent-relay/sessions/<id>.json with a Unix socket. We POST to it; Claude's
// replies come back either on the open request (wait_for_reply) or through
// ~/.agent-relay/mailbox/<thread>.jsonl, drained by claude_inbox and by this
// plugin's Stop / UserPromptSubmit hooks.
//
// Zero dependencies; MCP over newline-delimited JSON-RPC on stdio.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const RELAY_HOME = process.env.AGENT_RELAY_HOME || path.join(os.homedir(), '.agent-relay')
const SESSIONS = path.join(RELAY_HOME, 'sessions')
const MAILBOX = path.join(RELAY_HOME, 'mailbox')

// ---------------------------------------------------------------- sessions ---

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function liveSessions() {
  let files = []
  try {
    files = fs.readdirSync(SESSIONS).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8'))
      if (isAlive(s.pid) && fs.existsSync(s.sock)) out.push(s)
      else fs.rmSync(path.join(SESSIONS, f), { force: true })
    } catch {}
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

function pickSession(selector, cwd) {
  const all = liveSessions()
  if (!all.length) throw new Error('No Claude Code session with the codex-relay mod is running.')
  if (selector) {
    const s = all.find(
      x => x.sessionId === selector || x.sessionId.startsWith(selector) || x.label === selector || x.cwd === selector,
    )
    if (!s) throw new Error(`No Claude session matches "${selector}". Live: ${all.map(describe).join('; ')}`)
    return s
  }
  if (all.length === 1) return all[0]
  const near = cwd && all.filter(x => cwd === x.cwd || cwd.startsWith(x.cwd + '/') || x.cwd.startsWith(cwd + '/'))
  if (near && near.length === 1) return near[0]
  throw new Error(`Several Claude sessions are running; pass session. Live: ${all.map(describe).join('; ')}`)
}

function describe(s) {
  return `${s.sessionId.slice(0, 8)} "${s.label}" (${s.cwd})`
}

function post(sock, route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      {
        socketPath: sock,
        path: route,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        timeout: timeoutMs,
      },
      res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', c => (text += c))
        res.on('end', () => {
          try {
            const json = JSON.parse(text)
            res.statusCode >= 400 ? reject(new Error(json.error ?? text)) : resolve(json)
          } catch {
            reject(new Error(text || `HTTP ${res.statusCode}`))
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timed out waiting for Claude')))
    req.on('error', reject)
    req.end(data)
  })
}

function drainMailbox(threadId) {
  if (!threadId) return []
  const file = path.join(MAILBOX, `${threadId.replace(/[^\w.-]/g, '_')}.jsonl`)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
    fs.rmSync(file)
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
}

// ------------------------------------------------------------------- tools ---

const TOOLS = [
  {
    name: 'claude_sessions',
    description:
      'List running Claude Code sessions you can message (they need the codex-relay mod), with the agents in each.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'claude_send',
    description:
      'Send a message to a Claude Code session (its main conversation by default, or one of its agents via `to`). With wait_for_reply (default true) this blocks until Claude answers and returns the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message. Claude sees none of your context: be self-contained.' },
        session: { type: 'string', description: 'Session id prefix, label or cwd from claude_sessions; optional if only one is running.' },
        to: { type: 'string', description: 'An agent name in that session (from claude_sessions); omit for its main conversation.' },
        name: { type: 'string', description: 'How to introduce yourself to Claude (e.g. "codex-app: refactor thread").' },
        wait_for_reply: { type: 'boolean', description: 'Block until Claude replies (default true).' },
        timeout_sec: { type: 'number', description: 'How long to wait for a reply (default 900).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'claude_inbox',
    description: 'Read (and clear) messages Claude sent to this thread that have not been delivered yet.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function threadFromMeta(meta) {
  let m = meta?.['x-codex-turn-metadata']
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m)
    } catch {
      m = null
    }
  }
  return m?.thread_id ?? m?.threadId ?? process.env.CODEX_THREAD_ID ?? null
}

async function callTool(name, args, meta) {
  const threadId = threadFromMeta(meta)
  switch (name) {
    case 'claude_sessions': {
      const all = liveSessions()
      if (!all.length) return 'No Claude Code session with the codex-relay mod is running.'
      return all
        .map(
          s =>
            `${describe(s)}\n` +
            (s.roster ?? []).map(r => `  - ${r.name} (${r.kind}${r.status ? `, ${r.status}` : ''})`).join('\n'),
        )
        .join('\n')
    }
    case 'claude_send': {
      const s = pickSession(args.session, args.cwd ?? meta?.cwd)
      const wait = args.wait_for_reply !== false
      const timeoutMs = Math.max(10, Number(args.timeout_sec ?? 900)) * 1000
      const res = await post(
        s.sock,
        '/inbound',
        {
          fromThread: threadId,
          fromName: args.name ?? (threadId ? `codex thread ${threadId.slice(0, 8)}` : 'codex'),
          to: args.to ?? null,
          text: args.text,
          awaitReply: wait && !!threadId,
          timeoutMs,
        },
        timeoutMs + 5000,
      )
      if (!wait) return `Delivered to Claude session ${describe(s)}. Replies arrive in claude_inbox or at your turn's end.`
      if (!threadId)
        return `Delivered to ${describe(s)}, but this client did not identify its thread, so a reply can't be routed back to you.`
      if (res.reply?.isError) return res.reply.text
      if (res.reply) return `Claude (${res.reply.from}) replied:\n${res.reply.text}`
      return `Delivered to ${describe(s)}; no reply within ${timeoutMs / 1000}s. A later reply lands in claude_inbox.`
    }
    case 'claude_inbox': {
      const msgs = drainMailbox(threadId)
      if (!threadId) return 'This client did not identify its thread; no inbox.'
      if (!msgs.length) return 'No new messages from Claude.'
      return msgs.map(m => `[from ${m.from}] ${m.text}`).join('\n\n')
    }
    default:
      throw new Error(`unknown tool ${name}`)
  }
}

// --------------------------------------------------------------------- mcp ---

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function onMessage(msg) {
  if (msg.method === 'initialize') {
    return write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-relay', version: '0.1.0' },
        instructions:
          'Talk to Claude Code sessions running on this machine. claude_send asks Claude something and (by default) waits for the answer.',
      },
    })
  }
  if (msg.method === 'tools/list') return write({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
  if (msg.method === 'tools/call') {
    try {
      const text = await callTool(msg.params.name, msg.params.arguments ?? {}, msg.params._meta)
      return write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } })
    } catch (err) {
      return write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(err.message ?? err) }], isError: true } })
    }
  }
  if (msg.method === 'ping') return write({ jsonrpc: '2.0', id: msg.id, result: {} })
  if (msg.id !== undefined && msg.method)
    write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    void onMessage(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
