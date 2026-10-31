#!/usr/bin/env node
// relay-bridge: one per Claude session. Owns a `codex app-server` child over
// stdio and exposes it to the codex-relay mod (and to Codex-side relay MCP
// servers) as JSON over HTTP on a Unix socket.
//
// The mod can't hold a duplex pipe ($.process.spawn's stdin is one-shot), so:
//   mod -> bridge   HTTP over the socket ($.http.fetch with socketPath)
//   bridge -> mod   JSONL on this process's stdout (the mod's spawn loop)
//                   + long-poll GET /events for waits that must not burn a
//                     hook's own-time budget
//
// Zero dependencies; Node >= 18.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const args = parseArgs(process.argv.slice(2))
const RELAY_HOME = process.env.AGENT_RELAY_HOME || path.join(os.homedir(), '.agent-relay')
const SESSION_ID = args.session || `anon-${process.pid}`
const SOCK = args.sock || path.join(RELAY_HOME, 'run', `${SESSION_ID.slice(0, 12)}.sock`)
const REGISTRY = path.join(RELAY_HOME, 'sessions', `${SESSION_ID}.json`)
const MAILBOX_DIR = path.join(RELAY_HOME, 'mailbox')
const CWD = args.cwd || process.cwd()
const TRANSPORT = args.transport || 'spawn' // spawn | daemon
const MAX_EVENTS = 4000

let label = args.label || path.basename(CWD)
let roster = [] // addressable Claude agents, published for Codex-side callers

// ---------------------------------------------------------------- output ---

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function log(...parts) {
  process.stderr.write(`[relay-bridge] ${parts.join(' ')}\n`)
}

// ----------------------------------------------------------- app-server ---

const codexBin = resolveCodex(args.codex)
const codexArgv =
  TRANSPORT === 'daemon' ? ['app-server', 'proxy'] : ['app-server', '--listen', 'stdio://']
const child = spawn(codexBin, codexArgv, {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_RELAY_SESSION: SESSION_ID },
})
child.on('error', err => {
  emit({ type: 'fatal', message: `could not start ${codexBin}: ${err.message}` })
  shutdown(1)
})
child.on('exit', (code, signal) => {
  emit({ type: 'fatal', message: `codex app-server exited (code ${code}, signal ${signal})` })
  shutdown(1)
})
child.stderr.on('data', d => process.stderr.write(d))

let rpcId = 1
const pending = new Map() // our request id -> {resolve, reject, timer}
lineReader(child.stdout, onAppServerLine)

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n')
}

function rpc(method, params, timeoutMs = 120_000) {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    send({ id, method, params })
  })
}

// Server -> client requests we hold until the mod answers via POST /respond.
const serverRequests = new Map()

function onAppServerLine(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log('unparseable app-server line:', line.slice(0, 200))
    return
  }
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }))
    else p.resolve(msg.result)
    return
  }
  if (msg.id !== undefined && msg.method !== undefined) {
    serverRequests.set(String(msg.id), msg)
    const ev = record({ kind: 'request', id: msg.id, method: msg.method, params: msg.params })
    emit({ type: 'request', ...ev })
    return
  }
  if (msg.method) {
    const ev = record({ kind: 'notification', method: msg.method, params: msg.params })
    if (GLOBAL_NOTIFICATIONS.has(msg.method)) emit({ type: 'notification', ...ev })
  }
}

// Notifications the mod's global loop cares about; everything else is only
// served through /events to whoever is waiting on that thread.
const GLOBAL_NOTIFICATIONS = new Set([
  'thread/started',
  'turn/started',
  'turn/completed',
  'thread/name/updated',
  'thread/status/changed',
  'item/started',
  'error',
])

// ---------------------------------------------------------------- events ---

let seq = 0
const events = []
const waiters = new Set()

function threadOf(params) {
  if (!params || typeof params !== 'object') return undefined
  return params.threadId ?? params.thread?.id ?? params.conversationId
}

function record(ev) {
  const full = { seq: ++seq, threadId: threadOf(ev.params), at: Date.now(), ...ev }
  events.push(full)
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
  for (const w of waiters) w.check()
  return full
}

function eventsSince(since, threadId, kind) {
  return events.filter(e => e.seq > since && (!threadId || e.threadId === threadId) && (!kind || e.kind === kind))
}

// --------------------------------------------------------------- mailbox ---
// Messages for Codex threads this bridge doesn't run (e.g. ones open in the
// Codex app), drained by that thread's claude-relay MCP server.

const replyWaiters = new Map() // codex threadId -> [{resolve}]

function mailboxPath(threadId) {
  return path.join(MAILBOX_DIR, `${threadId.replace(/[^\w.-]/g, '_')}.jsonl`)
}

function deliverToExternalThread(threadId, message) {
  const q = replyWaiters.get(threadId)
  if (q && q.length) {
    q.shift().resolve(message)
    if (!q.length) replyWaiters.delete(threadId)
    return 'replied'
  }
  fs.mkdirSync(MAILBOX_DIR, { recursive: true })
  fs.appendFileSync(mailboxPath(threadId), JSON.stringify(message) + '\n')
  return 'mailbox'
}

// ------------------------------------------------------------------ http ---

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay')
  try {
    const body = req.method === 'POST' ? await readJson(req) : {}
    const out = await route(req.method, url, body, req, res)
    if (out !== undefined) json(res, 200, out)
  } catch (err) {
    json(res, 500, { error: err.message, rpc: err.rpc })
  }
})

async function route(method, url, body, req, res) {
  switch (`${method} ${url.pathname}`) {
    case 'GET /health':
      return { ok: true, sessionId: SESSION_ID, label, cwd: CWD, pid: process.pid, seq, transport: TRANSPORT }

    case 'POST /rpc':
      return { result: await rpc(body.method, body.params ?? {}, body.timeoutMs) }

    case 'POST /respond': {
      const key = String(body.id)
      const reqMsg = serverRequests.get(key)
      if (!reqMsg) return { ok: false, error: 'no such pending request' }
      serverRequests.delete(key)
      send(body.error ? { id: reqMsg.id, error: body.error } : { id: reqMsg.id, result: body.result ?? {} })
      record({ kind: 'responded', id: reqMsg.id, method: reqMsg.method, params: reqMsg.params })
      return { ok: true }
    }

    case 'GET /events': {
      const since = Number(url.searchParams.get('since') ?? 0)
      const threadId = url.searchParams.get('thread') || undefined
      const kind = url.searchParams.get('kind') || undefined
      const timeoutMs = Math.min(Number(url.searchParams.get('timeoutMs') ?? 25_000), 55_000)
      const superseded = isSuperseded()
      const ready = eventsSince(since, threadId, kind)
      // Only a caller that hands over (the inbox's wait) returns at once.
      const handsOver = superseded && url.searchParams.get('handover') === '1'
      if (ready.length || timeoutMs <= 0 || handsOver) return { events: ready, seq, superseded }
      await new Promise(resolve => {
        const w = {
          check() {
            if (eventsSince(since, threadId, kind).length) done()
          },
        }
        const timer = setTimeout(done, timeoutMs)
        function done() {
          clearTimeout(timer)
          waiters.delete(w)
          resolve()
        }
        waiters.add(w)
        req.on('close', done)
      })
      return { events: eventsSince(since, threadId, kind), seq, superseded: isSuperseded() }
    }

    // From a Codex-side relay MCP server: a Codex thread messaging Claude.
    case 'POST /inbound': {
      const replyId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const msg = {
        replyId,
        fromThread: body.fromThread ?? null,
        fromName: body.fromName ?? null,
        to: body.to ?? null,
        text: String(body.text ?? ''),
        awaitReply: Boolean(body.awaitReply),
      }
      // Keyed by the sending thread, which the inbox answers to.
      const ev = record({ kind: 'inbound', threadId: msg.fromThread ?? 'unknown', params: msg })
      emit({ type: 'inbound', seq: ev.seq, ...msg })
      if (!msg.awaitReply || !msg.fromThread) return { delivered: true, replyId }
      const timeoutMs = Math.min(Number(body.timeoutMs ?? 600_000), 3_600_000)
      const reply = await new Promise(resolve => {
        const entry = { resolve }
        const list = replyWaiters.get(msg.fromThread) ?? []
        list.push(entry)
        replyWaiters.set(msg.fromThread, list)
        const timer = setTimeout(() => {
          const l = replyWaiters.get(msg.fromThread)
          if (l) replyWaiters.set(msg.fromThread, l.filter(x => x !== entry))
          resolve(null)
        }, timeoutMs)
        const orig = entry.resolve
        entry.resolve = v => (clearTimeout(timer), orig(v))
        req.on('close', () => entry.resolve(null))
      })
      return { delivered: true, replyId, reply }
    }

    // From the mod: Claude answering an external Codex thread.
    case 'POST /reply': {
      if (!body.threadId) throw new Error('threadId required')
      const how = deliverToExternalThread(body.threadId, {
        from: body.from ?? 'claude',
        text: String(body.text ?? ''),
        at: Date.now(),
        ...(body.isError ? { isError: true } : {}),
      })
      return { ok: true, how }
    }

    case 'GET /mailbox': {
      const threadId = url.searchParams.get('thread')
      if (!threadId) throw new Error('thread required')
      const file = mailboxPath(threadId)
      if (!fs.existsSync(file)) return { messages: [] }
      const text = fs.readFileSync(file, 'utf8')
      fs.rmSync(file)
      return { messages: text.split('\n').filter(Boolean).map(l => JSON.parse(l)) }
    }

    // The mod's trace lines: inspectable with GET /events and in stderr.
    case 'POST /log':
      log('mod:', String(body.text ?? ''))
      record({ kind: 'log', params: { text: String(body.text ?? '') } })
      return { ok: true }

    case 'POST /meta':
      if (typeof body.label === 'string') label = body.label
      if (Array.isArray(body.roster)) roster = body.roster
      writeRegistry()
      return { ok: true }

    default:
      return json(res, 404, { error: `no route ${method} ${url.pathname}` })
  }
}

// ------------------------------------------------------------- lifecycle ---

// A mod reload starts a new bridge while the old module (and so this bridge)
// lives on until its hooks in flight return. The newest bridge owns the
// registry; an older one stops writing it and tells its long-pollers so.
function isSuperseded() {
  try {
    const cur = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
    return cur.pid !== process.pid && cur.startedAt >= startedAt
  } catch {
    return false
  }
}

function writeRegistry() {
  if (isSuperseded()) return
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true })
  fs.writeFileSync(
    REGISTRY,
    JSON.stringify(
      { sessionId: SESSION_ID, sock: SOCK, cwd: CWD, label, pid: process.pid, startedAt, roster },
      null,
      2,
    ),
  )
}

const startedAt = Date.now()
let closing = false

function shutdown(code = 0) {
  if (closing) return
  closing = true
  try {
    if (!isSuperseded()) fs.rmSync(REGISTRY, { force: true })
  } catch {}
  try {
    fs.rmSync(SOCK, { force: true })
  } catch {}
  try {
    child.kill('SIGTERM')
  } catch {}
  setTimeout(() => process.exit(code), 200).unref()
}

process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
process.on('SIGHUP', () => shutdown(0))
// The mod kills us when its module unloads; this covers the engine dying
// without doing so (we'd be reparented to launchd).
const parent = process.ppid
setInterval(() => {
  if (process.ppid !== parent) shutdown(0)
}, 2000).unref()

async function main() {
  // sockaddr_un caps paths at 104 bytes on macOS; bind() would silently truncate.
  if (Buffer.byteLength(SOCK) > 100) throw new Error(`socket path too long (${SOCK.length} > 100): ${SOCK}`)
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 })
  fs.rmSync(SOCK, { force: true })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(SOCK, resolve)
  })
  fs.chmodSync(SOCK, 0o600)
  const init = await rpc('initialize', {
    clientInfo: { name: 'agent-relay', title: 'Claude Code relay', version: '0.1.0' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      optOutNotificationMethods: [
        'item/reasoning/textDelta',
        'item/commandExecution/outputDelta',
        'item/fileChange/outputDelta',
        'thread/tokenUsage/updated',
        'account/rateLimits/updated',
        'mcpServer/startupStatus/updated',
      ],
    },
  })
  send({ method: 'initialized' })
  writeRegistry()
  emit({ type: 'ready', sock: SOCK, sessionId: SESSION_ID, codex: codexBin, init })
}

main().catch(err => {
  emit({ type: 'fatal', message: err.message })
  shutdown(1)
})

// --------------------------------------------------------------- helpers ---

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1]?.startsWith('--') ? 'true' : argv[++i]
  }
  return out
}

function resolveCodex(explicit) {
  if (explicit && explicit !== 'codex') return explicit
  const dirs = (process.env.PATH || '').split(':')
  // GUI-launched hosts often run with a minimal PATH.
  dirs.push(
    path.join(os.homedir(), '.n/bin'),
    path.join(os.homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  )
  for (const d of dirs) {
    const p = path.join(d, 'codex')
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  return 'codex'
}

function lineReader(stream, onLine) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) onLine(line)
    }
  })
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', c => (data += c))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function json(res, status, obj) {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}
