// codex-relay: OpenAI Codex threads as Claude subagents.
//
// A Codex subagent is a real Claude subagent (agent type `codex-relay:codex`)
// whose model steps this mod answers itself: `turn.step` never calls the
// Anthropic API for it, it drives a Codex thread through `codex app-server`
// and streams the thread's messages back as the step's response. So the
// subagent shows in the task list, SendMessage reaches it (steered into the
// running Codex turn, or resuming it), and its answer returns like any agent.
//
// The app-server lives behind bridge/relay-bridge.mjs (see its header).
// Every long wait goes through `$.http.fetch` long-polls on the bridge:
// a hook's 10s budget counts only its own time, and `$` calls are free.

import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  EngineInterface,
  PluginOptions,
  Register,
  SessionMessage,
  TurnStepChunk,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code'

import type { CodexBinding, ExternalPeer } from '../types'

type $ = EngineInterface

const AGENT = 'codex-relay:codex'
const INBOX = 'codex-relay:inbox'
const MARK = '⁣codex-relay:'
const SEP = '\u2063'
// Invisible tag opening a Codex subagent's prompt. turn.step identifies its
// agents by their own first row: a first step can run before agent.spawn's
// `next` resolves and before $.agent.list() lists the agent.
const CODEX_TAG = '\u2063\u2064\u2063'
const INBOX_TAG = '\u2064\u2063\u2064' // the same, for the inbox
const INBOX_WAIT = 'mcp__codex-relay__codex_inbox_wait'
// How long one wait holds; each is two rows in the inbox’s transcript.
const INBOX_WAIT_MS = 10 * 60_000
const POLL_MS = 4000 // bounds how long an interrupt waits to be noticed

const bindings = atom({ plugin: 'codex-relay', key: 'bindings' } as const, {} as Record<string, CodexBinding>, {
  shape: 'bindings-1',
})
const peers = atom({ plugin: 'codex-relay', key: 'peers' } as const, {} as Record<string, ExternalPeer>, {
  shape: 'peers-3',
})

// ------------------------------------------------------------ module state ---
// All of this is per module instance: a reload kills the bridge with the
// module, and the next session.start brings up a fresh one. Bindings (in
// $.state) survive, so threads are resumed lazily on next use.

type Model = { id: string; isDefault: boolean; efforts: string[]; defaultEffort: string }
type SpawnCfg = { model: string | null; effort: string | null; sandbox: string | null; cwd: string | null }
type BridgeEvent = {
  seq: number
  kind: string
  method?: string
  threadId?: string
  id?: number | string
  params?: any
}

let sock = ''
let ready: Promise<void> = Promise.reject(new Error('bridge not started'))
ready.catch(() => {})
let models: Model[] = []
// Codex's own configured defaults (config.toml), what a thread gets when
// neither the spawn nor the mod's options name a model or effort.
let configModel: string | null = null
let configEffort: string | null = null
let resolveMeta!: () => void
let metaReady = new Promise<void>(r => (resolveMeta = r))
const loadedThreads = new Set<string>()
const pendingSpawns = new Map<string, SpawnCfg>()
// A spawn's resolved config by agent name, for a first step that races the
// agent.spawn hook's createBinding (the prompt it reads is already stripped).
const spawnCfgByName = new Map<string, SpawnCfg>()
let sessionCwd = ''
let opts: PluginOptions = {}
// The thread each agent drives, as this instance created or resumed it:
// read before $.state, whose write can trail a reader in another hook.
const threadOfAgent = new Map<string, string>()

// Fire-and-forget diagnostics, readable from the bridge (GET /events, kind "log").
function trace($: $, text: string) {
  void api($, '/log', { text }).catch(() => {})
}

// ------------------------------------------------------------------ bridge ---

async function api<T = any>($: $, path: string, body?: unknown): Promise<T> {
  await ready
  const res = await $.http.fetch(`http://relay${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    socketPath: sock,
  })
  const data = res.text ? JSON.parse(res.text) : {}
  if (!res.ok) throw new Error(data.error ?? `bridge ${path}: HTTP ${res.status}`)
  return data as T
}

async function rpc<T = any>($: $, method: string, params: unknown): Promise<T> {
  return (await api<{ result: T }>($, '/rpc', { method, params })).result
}

async function which($: $, bin: string): Promise<string> {
  const shell = (await $.env.get('SHELL')) ?? '/bin/sh'
  try {
    const { exitCode, stdout } = await $.process.run([shell, '-lc', `command -v ${bin}`], { timeoutMs: 10_000 })
    const found = stdout.trim().split('\n').pop()
    if (exitCode === 0 && found) return found
  } catch {}
  return bin
}

function startBridge($: $, cwd: string) {
  let resolveReady!: () => void
  let rejectReady!: (err: Error) => void
  ready = new Promise<void>((res, rej) => ((resolveReady = res), (rejectReady = rej)))
  ready.catch(() => {})

  void (async () => {
    try {
      const home = (await $.env.get('HOME')) ?? '/tmp'
      const sid = await $.session.id()
      const node = String(opts.nodePath || (await which($, 'node')))
      const codex = String(opts.codexPath || (await which($, 'codex')))
      sock = `${home}/.agent-relay/run/${sid.slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}.sock`
      const argv = [
        node,
        `${$.plugin.root}/bridge/relay-bridge.mjs`,
        ...['--session', sid, '--sock', sock, '--cwd', cwd, '--codex', codex],
        ...['--transport', String(opts.transport || 'spawn'), '--label', cwd.split('/').pop() || cwd],
      ]
      let buf = ''
      for await (const chunk of $.process.spawn({ argv, cwd })) {
        if (chunk.stream === 'stderr') {
          $.ui.log(chunk.text.trimEnd(), { to: 'debug' })
          continue
        }
        buf += chunk.text
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line) continue
          let ev: any
          try {
            ev = JSON.parse(line)
          } catch {
            continue
          }
          if (ev.type === 'ready') {
            resolveReady()
            void afterReady($)
          } else if (ev.type === 'fatal') {
            rejectReady(new Error(ev.message))
            $.ui.toast(`codex-relay: ${ev.message}`)
          } else {
            void onBridgeEvent($, ev).catch(err => $.ui.log(`event ${ev.method}: ${err}`, { to: 'debug' }))
          }
        }
      }
      rejectReady(new Error('the codex bridge exited'))
      $.ui.status('codex: bridge stopped')
    } catch (err) {
      rejectReady(err instanceof Error ? err : new Error(String(err)))
      $.ui.toast(`codex-relay: bridge failed: ${err}`)
    }
  })()
}

async function afterReady($: $) {
  try {
    const list = await rpc<{ data: any[] }>($, 'model/list', {})
    models = list.data
      .filter(m => !m.hidden)
      .map(m => ({
        id: m.id,
        isDefault: m.isDefault,
        defaultEffort: m.defaultReasoningEffort,
        efforts: m.supportedReasoningEfforts.map((r: any) => r.reasoningEffort),
      }))
    await registerSpawnTool($)
  } catch (err) {
    $.ui.log(`model/list failed: ${err}`, { to: 'debug' })
  }
  try {
    const { config } = await rpc<any>($, 'config/read', { cwd: sessionCwd })
    configModel = config.model ?? null
    configEffort = config.model_reasoning_effort ?? null
  } catch (err) {
    $.ui.log(`config/read failed: ${err}`, { to: 'debug' })
  }
  resolveMeta()
  await publishRoster($)
  await refreshStatus($)
}

// The model and effort a spawn will actually run on, resolved up front so
// the task list, status line and turn/start all say the same thing.
function resolveModel(cfg: SpawnCfg): { model: string | null; effort: string | null } {
  const optEffort = opts.defaultEffort && opts.defaultEffort !== 'config' ? String(opts.defaultEffort) : null
  const model =
    cfg.model ?? (opts.defaultModel ? String(opts.defaultModel) : null) ?? configModel ?? models.find(m => m.isDefault)?.id ?? null
  const effort = cfg.effort ?? optEffort ?? configEffort ?? models.find(m => m.id === model)?.defaultEffort ?? null
  return { model, effort }
}

function modelLabel(b: { model: string | null; effort: string | null }): string {
  return `${b.model ?? 'codex default'} · ${b.effort ?? 'default effort'}`
}

// A bridge that fails rejects `ready`, so a spawn never waits on it forever.
async function awaitMeta() {
  await ready.then(() => metaReady).catch(() => {})
}

// --------------------------------------------------------------- bindings ---

async function setBinding($: $, agentId: string, patch: Partial<CodexBinding>) {
  await update($, bindings, all => {
    const cur = all[agentId]
    return cur ? { ...all, [agentId]: { ...cur, ...patch } } : all
  })
}

function findBinding(all: Record<string, CodexBinding>, key: string): CodexBinding | undefined {
  const k = key.replace(/^codex:/, '')
  return Object.values(all).find(b => b.agentId === k || b.name === k || b.threadId === k)
}

// The agent's binding, created on first sight. agent.spawn creates it once
// `next` resolves, but the subagent's first step can race ahead of that.
async function ensureBinding($: $, agentId: string, info: AgentInfo): Promise<CodexBinding> {
  const have = (await read($, bindings))[agentId]
  if (have) return have
  const first = (await rowsOf($, agentId)).find(m => m.role === 'user')?.text ?? ''
  return createBinding($, agentId, {
    name: info.name ?? `codex-${agentId.slice(0, 6)}`,
    parentAgentId: info.parentId ?? null,
    cfg: (info.name && spawnCfgByName.get(info.name)) || takeSpawnCfg(first).cfg,
  })
}

async function createBinding(
  $: $,
  agentId: string,
  { name, parentAgentId, cfg }: { name: string; parentAgentId: string | null; cfg: SpawnCfg },
): Promise<CodexBinding> {
  const { model, effort } = resolveModel(cfg)
  const fresh: CodexBinding = {
    agentId,
    name,
    threadId: null,
    model,
    effort,
    sandbox: cfg.sandbox ?? String(opts.sandbox || 'workspace-write'),
    cwd: cfg.cwd ?? sessionCwd,
    parentAgentId,
    activeTurnId: null,
    status: 'starting',
    activity: 'starting',
    createdAt: await $.clock.now(),
  }
  let out = fresh
  await update($, bindings, all => {
    if (all[agentId]) return ((out = all[agentId]!), all)
    return { ...all, [agentId]: fresh }
  })
  void publishRoster($)
  return out
}

// A spawn's model/effort ride in on its prompt behind an invisible marker,
// since the Agent call has nowhere else to carry them to agent.spawn.
function takeSpawnCfg(prompt: string): { cfg: SpawnCfg; prompt: string } {
  const none: SpawnCfg = { model: null, effort: null, sandbox: null, cwd: null }
  if (!prompt.startsWith(MARK)) return { cfg: none, prompt }
  const end = prompt.indexOf('⁣', MARK.length)
  const token = prompt.slice(MARK.length, end)
  const cfg = pendingSpawns.get(token) ?? none
  return { cfg, prompt: prompt.slice(end + 1).replace(/^\n/, '') }
}

async function ensureThread($: $, b: CodexBinding): Promise<string> {
  const known = b.threadId ?? threadOfAgent.get(b.agentId) ?? null
  if (known && loadedThreads.has(known)) return known
  if (known) {
    await rpc($, 'thread/resume', { threadId: known, developerInstructions: instructionsFor(b) })
    loadedThreads.add(known)
    threadOfAgent.set(b.agentId, known)
    return known
  }
  const started = await rpc<any>($, 'thread/start', {
    model: b.model,
    cwd: b.cwd,
    approvalPolicy: 'never',
    sandbox: b.sandbox,
    serviceName: 'agent-relay',
    developerInstructions: instructionsFor(b),
    dynamicTools: CODEX_TOOLS,
  })
  const threadId: string = started.thread.id
  loadedThreads.add(threadId)
  threadOfAgent.set(b.agentId, threadId)
  trace($, `agent ${b.agentId} (${b.name}) → thread ${threadId}`)
  await setBinding($, b.agentId, {
    threadId,
    model: started.model ?? b.model,
    effort: b.effort ?? started.reasoningEffort ?? null,
  })
  void rpc($, 'thread/name/set', { threadId, name: `Claude › ${b.name}` }).catch(() => {})
  return threadId
}

function instructionsFor(b: CodexBinding): string {
  return [
    `You are "${b.name}", an OpenAI Codex agent running as a subagent of a Claude Code session (via agent-relay).`,
    '- Your final message each turn is returned to Claude as your result: make it a complete, self-contained report.',
    '- Messages from Claude agents arrive as user messages that start with "[message from …]", sometimes mid-turn. Treat them as direction from whoever delegated to you.',
    '- To ask Claude a question or report progress before you finish, call `claude_send`. It does not wait for a reply; any reply arrives as a later user message.',
    '- `claude_agents` lists who you can message: the Claude main conversation, Claude subagents, and other Codex subagents.',
  ].join('\n')
}

// Tools the mod serves to every Codex thread it starts (app-server dynamic tools).
const CODEX_TOOLS = [
  {
    type: 'function',
    name: 'claude_send',
    description:
      'Send a message to a Claude agent. Defaults to the Claude agent that delegated to you. Returns once delivered; replies arrive later as user messages.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message.' },
        to: { type: 'string', description: 'Recipient name from claude_agents; omit for your delegator.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'claude_agents',
    description: 'List the Claude and Codex agents in this Claude session that you can message with claude_send.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

// ----------------------------------------------------------- the subagent ---

// The text the Claude side has handed this agent since its last answer: the
// spawn prompt on its first turn, a resuming message on later ones.
async function pendingInput($: $, agentId: string): Promise<string> {
  const rows = await rowsOf($, agentId)
  let lastAssistant = -1
  rows.forEach((r, i) => r.role === 'assistant' && (lastAssistant = i))
  return rows
    .slice(lastAssistant + 1)
    .filter(r => r.role === 'user' && r.text.trim())
    .map(r => takeSpawnCfg(r.text.replace(CODEX_TAG, '')).prompt)
    .join('\n\n')
}

async function rowsOf($: $, agentId: string): Promise<SessionMessage[]> {
  const rows = await $.session.messages({ agentId })
  return Array.isArray(rows) ? rows : []
}

function textInput(text: string) {
  return { type: 'text', text, text_elements: [] }
}

// A Codex turn spans as many Claude steps as it makes claude_send calls: each
// call ends a step with a real SendMessage tool use, which the engine runs in
// this subagent's own loop (so it reaches its recipient as this agent's
// message), and the next step hands the tool's result back to Codex.
type Flight = {
  threadId: string
  turnId: string
  since: number
  pending: { requestId: number | string; toolUseId: string } | null
}
const flights = new Map<string, Flight>()

function toolUseId(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let id = 'toolu_01'
  for (let i = 0; i < 22; i++) id += abc[Math.floor(Math.random() * abc.length)]
  return id
}

async function* driveCodex(
  $: $,
  e: TurnStepInput,
  b: CodexBinding,
  signal: AbortSignal,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const result = (answer: string, toolUses: TurnStepResult['toolUses'] = []): TurnStepResult => ({
    turnId: e.turnId,
    index: e.index,
    answer,
    toolUses,
    stopReason: toolUses.length ? 'tool_use' : 'end_turn',
    // Null, not Codex's counts: the engine books a step's usage against the
    // agent's Claude model, which never ran.
    usage: null,
  })

  let flight = flights.get(b.agentId)
  if (flight?.pending) {
    // Back from a SendMessage: its result is claude_send's answer.
    const { requestId, toolUseId: id } = flight.pending
    flight.pending = null
    const rows = await rowsOf($, b.agentId)
    const res = rows.flatMap(r => r.toolResults ?? []).find(t => t.tool_use_id === id)
    await api($, '/respond', {
      id: requestId,
      result: {
        contentItems: [{ type: 'inputText', text: res?.text || (res ? 'Sent.' : 'The message was not sent.') }],
        success: !!res && !res.isError,
      },
    })
  } else {
    const input = await pendingInput($, b.agentId)
    if (!input) {
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return result('')
    }
    const threadId = await ensureThread($, { ...b, ...(await read($, bindings))[b.agentId] })
    const cur = (await read($, bindings))[b.agentId] ?? b
    const since = (await api<{ seq: number }>($, '/health')).seq
    const started = await rpc<any>($, 'turn/start', {
      threadId,
      input: [textInput(input)],
      ...(cur.model ? { model: cur.model } : {}),
      ...(cur.effort ? { effort: cur.effort } : {}),
    })
    flight = { threadId, turnId: started.turn.id, since, pending: null }
    flights.set(b.agentId, flight)
    await setBinding($, b.agentId, { activeTurnId: flight.turnId, status: 'running', activity: 'thinking' })
    void refreshStatus($)
  }
  const { threadId, turnId } = flight

  let block = -1
  let blockKind: 'text' | 'thinking' | null = null
  let lastItem: string | null = null
  let answer = ''
  let failure: string | null = null
  let isInterrupted = false
  const open = (kind: 'text' | 'thinking') => {
    if (blockKind !== kind) {
      block++
      blockKind = kind
    }
    return block
  }

  for (;;) {
    if (signal.aborted && !isInterrupted) {
      isInterrupted = true
      await rpc($, 'turn/interrupt', { threadId, turnId }).catch(() => {})
    }
    const { events, seq } = await api<{ events: BridgeEvent[]; seq: number }>(
      $,
      `/events?since=${flight.since}&thread=${threadId}&timeoutMs=${POLL_MS}`,
    )
    let isDone = false
    for (const ev of events) {
      flight.since = ev.seq
      const p = ev.params ?? {}
      if (ev.kind === 'request' && ev.method === 'item/tool/call' && p.tool === 'claude_send' && p.turnId === turnId) {
        // Pause the step here; later events are read by the next step.
        const to = p.arguments?.to || (b.parentAgentId ? await agentAddress($, b.parentAgentId) : 'main')
        const text = String(p.arguments?.text ?? '')
        const input = { to, message: text, summary: `${b.name}: ${text.slice(0, 60)}` }
        const id = toolUseId()
        flight.pending = { requestId: ev.id!, toolUseId: id }
        block++
        yield { kind: 'tool', index: block, id, name: 'SendMessage' }
        yield { kind: 'input', index: block, json: JSON.stringify(input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return result(answer, [{ name: 'SendMessage', input }])
      }
      if (ev.kind !== 'notification') continue
      if (ev.method === 'item/agentMessage/delta' && p.turnId === turnId) {
        let text: string = p.delta
        if (p.itemId !== lastItem) {
          if (answer) text = `\n\n${text}`
          lastItem = p.itemId
        }
        answer += text
        yield { kind: 'text', index: open('text'), text }
      } else if (ev.method === 'item/started' && p.turnId === turnId) {
        const line = describeItem(p.item)
        if (line) {
          void setBinding($, b.agentId, { activity: line.slice(0, 80) })
          yield { kind: 'thinking', index: open('thinking'), text: `${line}\n` }
        }
      } else if (ev.method === 'turn/completed' && p.turn?.id === turnId) {
        isDone = true
        if (p.turn.status === 'failed') failure = p.turn.error?.message ?? 'the Codex turn failed'
        if (p.turn.status === 'interrupted') isInterrupted = true
        break
      } else if (ev.method === 'error' && p.turnId === turnId && !p.willRetry) {
        failure = p.error?.message ?? 'Codex reported an error'
      }
    }
    if (!events.length) flight.since = Math.max(flight.since, seq)
    if (isDone) break
  }

  flights.delete(b.agentId)
  await setBinding($, b.agentId, {
    activeTurnId: null,
    status: failure ? 'error' : isInterrupted ? 'interrupted' : 'idle',
    activity: failure ? `error: ${failure}`.slice(0, 80) : isInterrupted ? 'interrupted' : 'idle',
  })
  void refreshStatus($)

  if (failure && !answer.trim()) {
    answer = `Codex failed: ${failure}`
    yield { kind: 'text', index: open('text'), text: answer }
  }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return result(answer)
}

// What SendMessage addresses a Claude agent by: its name, else its id.
async function agentAddress($: $, agentId: string): Promise<string> {
  return (await $.agent.list()).find(a => a.id === agentId)?.name ?? agentId
}

function describeItem(item: any): string | null {
  switch (item?.type) {
    case 'commandExecution':
      return `$ ${item.command}`
    case 'fileChange':
      return `edit ${(item.changes ?? []).map((c: any) => c.path).join(', ')}`
    case 'mcpToolCall':
      return `mcp ${item.server}.${item.tool}`
    case 'dynamicToolCall':
      return `${item.tool} ${JSON.stringify(item.arguments ?? {}).slice(0, 120)}`
    case 'webSearch':
      return `search ${item.query ?? ''}`
    case 'collabAgentToolCall':
      return `codex subagent: ${item.tool}`
    default:
      return null
  }
}

// ---------------------------------------------------------------- messaging ---

// Codex-bound delivery to a subagent of ours: steered into its running turn,
// else handed to the Claude-side agent loop, which resumes and runs a turn.
async function sendToCodex($: $, b: CodexBinding, text: string, fromName: string): Promise<string> {
  const msg = `[message from ${fromName}]\n${text}`
  if (b.activeTurnId && b.threadId) {
    try {
      await rpc($, 'turn/steer', { threadId: b.threadId, expectedTurnId: b.activeTurnId, input: [textInput(msg)] })
      return `steered into ${b.name}'s running turn`
    } catch {}
  }
  const sent = await $.session.send({ to: { agentId: b.agentId }, text: msg })
  return sent.isDelivered ? `delivered to ${b.name}; it resumes with it` : `not delivered: ${sent.reason}`
}

async function senderName($: $, agentId: string | undefined): Promise<string> {
  if (!agentId) return 'claude (main)'
  const a = (await $.agent.list()).find(x => x.id === agentId)
  return `claude agent ${a?.name ?? agentId}`
}

async function rosterText($: $, selfAgentId?: string): Promise<string> {
  const all = await read($, bindings)
  const lines = ['main — the Claude main conversation']
  for (const a of await $.agent.list()) {
    if (a.id === selfAgentId) continue
    const codex = all[a.id]
    lines.push(
      codex
        ? `${codex.name} — Codex subagent (${modelLabel(codex)}, ${codex.status})`
        : `${a.name ?? a.id} — Claude subagent: ${a.description} (${a.status})`,
    )
  }
  return lines.join('\n')
}

async function publishRoster($: $) {
  try {
    const all = await read($, bindings)
    const roster = [
      { name: 'main', kind: 'claude' },
      ...Object.values(all).map(b => ({ name: b.name, kind: 'codex', threadId: b.threadId, status: b.status })),
    ]
    await api($, '/meta', { roster })
  } catch {}
}

async function refreshStatus($: $) {
  const all = Object.values(await read($, bindings))
  const running = all.filter(b => b.status === 'running')
  $.ui.status(
    running.length === 0
      ? undefined
      : running.length === 1
        ? `codex ${running[0]!.name} (${modelLabel(running[0]!)}): ${running[0]!.activity}`
        : `codex: ${running.length} running`,
  )
}

// ------------------------------------------------------- bridge → the mod ---

async function onBridgeEvent($: $, ev: any) {
  if (ev.type === 'request') return answerServerRequest($, ev)
  if (ev.type === 'inbound') return onInbound($, ev)
}

async function answerServerRequest($: $, ev: BridgeEvent) {
  const respond = (body: object) => api($, '/respond', { id: ev.id, ...body })
  if (ev.method === 'item/tool/call') {
    const p = ev.params
    const b = findBinding(await read($, bindings), p.threadId)
    trace($, `tool ${p.tool} from thread ${p.threadId} (${b?.name ?? 'unbound'})`)
    let text: string
    let ok = true
    // A subagent's own step answers claude_send, as its SendMessage (driveCodex).
    if (p.tool === 'claude_send' && b) return
    try {
      if (p.tool === 'claude_agents') {
        text = await rosterText($, b?.agentId)
      } else {
        ok = false
        text = `unknown tool ${p.tool}`
      }
    } catch (err) {
      ok = false
      text = `failed: ${err}`
    }
    return respond({ result: { contentItems: [{ type: 'inputText', text }], success: ok } })
  }
  // Threads run with approvalPolicy "never"; anything that still asks is declined.
  if (ev.method === 'item/commandExecution/requestApproval' || ev.method === 'item/fileChange/requestApproval')
    return respond({ result: { decision: 'decline' } })
  return respond({ error: { code: -32601, message: `codex-relay does not handle ${ev.method}` } })
}

// ------------------------------------------------------------- the inbox ---
// A Codex thread this session doesn't run (one open in the Codex app, via the
// claude-relay Codex plugin) reaches Claude through the inbox: one subagent of
// type `codex-relay:inbox`, whose steps the mod answers like a Codex
// subagent's. What a thread sends leaves as the inbox's own SendMessage, so
// Claude reads it as an agent's message, never as the person's prompt.
// Claude answers with SendMessage to `codex:<thread>`.
//
// It runs for the whole session because only an agent spawned from inside a
// hook gets this mod's turn.step: one spawned from the bridge's event loop (no
// hook running) would step on a real Claude model. So it starts in
// session.start or session.attach, and turn.start restarts it if it ended.
// Only while a surface draws the session: a headless -p run would never end.

type Inbound = { threadId: string; text: string; to: string | null; isAwaitingReply: boolean; name: string }

async function hasSurface($: $) {
  return (await $.session.surfaces()).length > 0
}
let inboxCursor = 0 // last bridge seq read; the bridge restarts with the module
let inboxQueue: Inbound[] = []
let inboxFlight: { toolUseId: string; threadIds: string[] } | null = null
let inboxStarting: Promise<void> | null = null
const inboxAgents = new Set<string>()
let inboxName: string | null = null
let isSupersededBridge = false

async function onInbound($: $, ev: any) {
  const threadId: string = ev.fromThread ?? 'unknown'
  const now = await $.clock.now()
  await update($, peers, all => ({
    ...all,
    [threadId]: {
      ...all[threadId],
      threadId,
      name: ev.fromName ?? threadId,
      lastText: String(ev.text).slice(0, 200),
      at: now,
      isAwaitingReply: !!ev.awaitReply,
    },
  }))
  // Otherwise it waits in the bridge for the inbox's next read.
  if (!(await hasSurface($))) await failInbound($, threadId, 'this Claude session runs headless, with no inbox')
}

// Call only from inside a hook (see above). A no-op while the inbox runs.
function ensureInbox($: $): Promise<void> {
  return (inboxStarting ??= (async () => {
    if (!(await hasSurface($))) return
    // Adopt one an earlier instance started: a reload must not leave two.
    // An idle one (its turn ended) stays listed but never steps again unwoken.
    const live = (await $.agent.list()).find(
      a => (a.type === INBOX || inboxAgents.has(a.id)) && ['pending', 'running', 'waiting'].includes(a.status),
    )
    if (live) {
      inboxAgents.add(live.id)
      inboxName = live.name ?? inboxName
      return
    }
    const name = await uniqueName($, 'codex-inbox')
    const spawned = await $.agent.spawn({
      subagentType: INBOX,
      prompt: `${INBOX_TAG}Relays messages from Codex threads outside this session (Codex app, CLI) to Claude.`,
      description: 'Codex inbox',
      name,
    })
    if (spawned.deny !== undefined) return trace($, `inbox not started: ${spawned.deny}`)
    inboxAgents.add(spawned.agentId!)
    inboxName = name
    trace($, `inbox ${name} (${spawned.agentId}) started`)
  })().finally(() => (inboxStarting = null)))
}

// Resolves the thread's held claude_send (or lands in its mailbox) with why
// Claude never got its message.
async function failInbound($: $, threadId: string, reason: string) {
  await api($, '/reply', { threadId, text: `Not delivered to Claude: ${reason}`, from: 'codex-relay', isError: true }).catch(() => {})
}

// Whether a loop is one of ours, from its own first row (see CODEX_TAG).
async function agentKind($: $, agentId: string): Promise<'codex' | 'inbox' | null> {
  if ((await read($, bindings))[agentId] || threadOfAgent.has(agentId)) return 'codex'
  if (inboxAgents.has(agentId)) return 'inbox'
  const first = (await rowsOf($, agentId)).find(m => m.role === 'user')?.text ?? ''
  if (first.startsWith(CODEX_TAG)) return 'codex'
  if (first.startsWith(INBOX_TAG)) return 'inbox'
  return null
}

// The binding agent.spawn's hook creates once `next` resolves, which a first
// step can beat: wait briefly for it, then create one from what's known.
async function awaitBinding($: $, agentId: string): Promise<CodexBinding> {
  for (let i = 0; i < 40; i++) {
    const have = (await read($, bindings))[agentId]
    if (have) return have
    const info = (await $.agent.list()).find(a => a.id === agentId)
    if (info) return ensureBinding($, agentId, info)
    // A long-poll on a thread nobody has: a sleep that costs no hook time.
    await api($, `/events?since=${Number.MAX_SAFE_INTEGER}&thread=-&timeoutMs=250`)
  }
  return createBinding($, agentId, { name: `codex-${agentId.slice(0, 6)}`, parentAgentId: null, cfg: resolveCfgNone() })
}

function resolveCfgNone(): SpawnCfg {
  return { model: null, effort: null, sandbox: null, cwd: null }
}

async function pullInbox($: $, timeoutMs: number) {
  const { events, seq, superseded } = await api<{ events: BridgeEvent[]; seq: number; superseded?: boolean }>(
    $,
    `/events?since=${inboxCursor}&kind=inbound&handover=1&timeoutMs=${timeoutMs}`,
  )
  if (superseded) isSupersededBridge = true
  for (const ev of events)
    inboxQueue.push({
      threadId: ev.threadId ?? 'unknown',
      text: String(ev.params?.text ?? ''),
      to: ev.params?.to ?? null,
      isAwaitingReply: !!ev.params?.awaitReply,
      name: ev.params?.fromName ?? ev.threadId ?? 'a Codex thread',
    })
  inboxCursor = events.length ? events[events.length - 1]!.seq : Math.max(inboxCursor, seq)
}

async function* driveInbox(
  $: $,
  e: TurnStepInput,
  agentId: string,
  signal: AbortSignal,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  if (inboxFlight) {
    // Back from the relaying SendMessage: tell the threads if it failed.
    const { toolUseId, threadIds } = inboxFlight
    inboxFlight = null
    const res = (await rowsOf($, agentId)).flatMap(r => r.toolResults ?? []).find(t => t.tool_use_id === toolUseId)
    if (!res || res.isError)
      for (const t of threadIds) await failInbound($, t, res?.text || 'the relaying SendMessage did not run')
  }
  if (!inboxQueue.length && !signal.aborted) await pullInbox($, 0)
  if (!inboxQueue.length) {
    // The wait runs as a tool call, not in this step: a reload keeps the old
    // module (and its bridge) alive until its hooks in flight return, so a
    // step that waited would keep the inbox on the old bridge. A wait returns
    // once its bridge is superseded, so the next step runs on the new module.
    const id = toolUseId()
    yield { kind: 'tool', index: 0, id, name: INBOX_WAIT }
    yield { kind: 'input', index: 0, json: '{}' }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: INBOX_WAIT, input: {} }], stopReason: 'tool_use', usage: null }
  }
  // One SendMessage per thread and recipient, the rest next step.
  const { threadId, to } = inboxQueue[0]!
  const batch = inboxQueue.filter(m => m.threadId === threadId && m.to === to)
  inboxQueue = inboxQueue.filter(m => !batch.includes(m))
  const name = batch[batch.length - 1]!.name
  const body = batch.map(m => m.text).join('\n\n')
  const blocked = batch.some(m => m.isAwaitingReply) ? ', blocked waiting for your reply' : ''
  const input = {
    to: to || 'main',
    message: `${body}\n\n(From Codex thread "${name}"${blocked}. Reply with SendMessage to "codex:${threadId}".)`,
    summary: `${name}: ${body.slice(0, 60)}`,
  }
  const id = toolUseId()
  inboxFlight = { toolUseId: id, threadIds: [threadId] }
  yield { kind: 'tool', index: 0, id, name: 'SendMessage' }
  yield { kind: 'input', index: 0, json: JSON.stringify(input) }
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'SendMessage', input }], stopReason: 'tool_use', usage: null }
}

// The inbox's wait. Returns once a message is queued, a reload superseded
// this module's bridge, or after a while.
async function inboxWait($: $, signal: AbortSignal): Promise<string> {
  const until = (await $.clock.now()) + INBOX_WAIT_MS
  while (!inboxQueue.length && !signal.aborted && (await $.clock.now()) < until) {
    await pullInbox($, POLL_MS)
    if (isSupersededBridge) return 'handing over to the reloaded relay'
  }
  return inboxQueue.length ? `${inboxQueue.length} message(s) to relay` : 'nothing yet'
}

// --------------------------------------------------------------- the tools ---

async function registerSpawnTool($: $) {
  const modelLine = models.length
    ? `Available models (efforts): ${models.map(m => `${m.id}${m.isDefault ? ' [default]' : ''} (${m.efforts.join('/')})`).join('; ')}.`
    : 'Call codex_list for the available models.'
  await $.tool.register({
    name: 'codex_spawn',
    isDeferred: false,
    description: [
      'Start an OpenAI Codex agent as a subagent, on a model and reasoning effort you choose. It works in its own Codex thread (its own shell, edits and sandbox) and its final message comes back as the result.',
      'It shows as a subagent named `name`: SendMessage to that name to message it (steered into its running turn, or resuming it with a new turn once it has finished). It can message you back; those arrive as messages from it.',
      modelLine,
      'wait=true (default) blocks until its first answer; wait=false returns at once and you are notified when it finishes.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task, self-contained: Codex sees none of this conversation.' },
        model: { type: 'string', description: 'Codex model id; omit for the configured default.' },
        effort: { type: 'string', description: 'Reasoning effort, e.g. low | medium | high | xhigh | max.' },
        name: { type: 'string', description: 'Short unique name to address it by (e.g. "codex-tests").' },
        description: { type: 'string', description: 'A few words for the task list.' },
        cwd: { type: 'string', description: 'Working directory; defaults to the session’s.' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
        wait: { type: 'boolean', description: 'Block until the first answer (default true).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  })
}

async function registerTools($: $) {
  await registerSpawnTool($)
  await $.tool.register({
    name: 'codex_send',
    description:
      'Message a Codex agent: a Codex subagent by name, or any Codex thread by "codex:<threadId>" (e.g. one in the Codex app that messaged you). Equivalent to SendMessage to the same address.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, text: { type: 'string' } },
      required: ['to', 'text'],
      additionalProperties: false,
    },
  })
  await $.tool.register({
    name: 'codex_list',
    description: 'List Codex subagents (model, effort, status, thread), Codex threads that messaged this session, and available Codex models.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  })
  await $.tool.register({
    name: 'codex_interrupt',
    description: 'Interrupt a Codex subagent’s running turn.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'], additionalProperties: false },
  })
  await $.agent.register({
    name: 'codex',
    description:
      'An OpenAI Codex agent (runs on Codex, not Claude). Prefer the codex_spawn tool, which picks the Codex model and effort; this type uses the configured defaults.',
    prompt: 'This agent is served by the codex-relay mod; its steps never reach the Anthropic API.',
    tools: ['SendMessage'],
    model: 'haiku',
  })
  await $.agent.register({
    name: 'inbox',
    description: 'Internal to codex-relay: relays Codex app/CLI threads to this session. Started by the mod, never by hand.',
    prompt: 'This agent is served by the codex-relay mod; its steps never reach the Anthropic API.',
    tools: ['SendMessage', INBOX_WAIT],
    model: 'haiku',
  })
  await $.tool.register({
    name: 'codex_inbox_wait',
    isDeferred: true,
    description: 'Internal to codex-relay’s inbox agent; refused to anyone else.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  })
  await $.command.register({ name: 'codex', description: 'Show Codex subagents and the inbox' })
}

async function listText($: $): Promise<string> {
  const all = Object.values(await read($, bindings))
  const ext = Object.values(await read($, peers))
  const out: string[] = []
  out.push(all.length ? 'Codex subagents:' : 'No Codex subagents yet.')
  for (const b of all)
    out.push(
      `- ${b.name}: ${b.status} (${b.activity}) · ${modelLabel(b)} · ${b.sandbox} · thread ${b.threadId ?? '(not started)'}`,
    )
  if (ext.length) {
    out.push('Codex threads that messaged this session:')
    for (const p of ext)
      out.push(
        `- ${p.name ?? p.threadId} (codex:${p.threadId})${p.isAwaitingReply ? ' — waiting for your reply' : ''}: “${p.lastText}”`,
      )
  }
  const inbox = (await $.agent.list()).filter(a => a.type === INBOX)
  out.push(inbox.length ? `Inbox: ${inbox.map(a => `${a.name ?? a.id} (${a.status}${inboxAgents.has(a.id) ? '' : ', not adopted'})`).join(', ')}` : 'Inbox: not running')
  if (models.length)
    out.push(`Models: ${models.map(m => `${m.id}${m.isDefault ? '*' : ''} [${m.efforts.join('/')}]`).join(', ')}`)
  return out.join('\n')
}

let spawnCount = 0

async function uniqueName($: $, wanted: string | undefined): Promise<string> {
  const taken = new Set([
    ...Object.values(await read($, bindings)).map(b => b.name),
    ...(await $.agent.list()).map(a => a.name).filter(Boolean),
  ])
  let base = (wanted || 'codex').replace(/[^\w.-]/g, '-')
  if (!wanted) base = `codex-${++spawnCount}`
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
  return name
}

// Long-poll the bridge until the agent's first Codex turn completes; its
// final messages are the answer.
async function waitForFirstAnswer($: $, agentId: string): Promise<string> {
  let since = 0
  for (;;) {
    const b = (await read($, bindings))[agentId]
    if (b?.status === 'error') return `Codex failed: ${b.activity}`
    const threadId = threadOfAgent.get(agentId) ?? b?.threadId
    const q = threadId ? `&thread=${threadId}` : ''
    const { events, seq } = await api<{ events: BridgeEvent[]; seq: number }>(
      $,
      `/events?since=${since}${q}&timeoutMs=20000`,
    )
    // Without a thread yet, rescan from 0 once it's known: its first events
    // may already be behind `since`.
    if (threadId) since = Math.max(since, seq)
    const done = threadId ? events.find(x => x.method === 'turn/completed' && x.threadId === threadId) : undefined
    if (done) {
      const turn = done.params.turn
      const text = (turn.items ?? [])
        .filter((i: any) => i.type === 'agentMessage')
        .map((i: any) => i.text)
        .join('\n\n')
      if (turn.status === 'failed') return `Codex failed: ${turn.error?.message ?? 'unknown error'}\n${text}`
      return text || '(Codex finished without a message)'
    }
  }
}

// -------------------------------------------------------------- the hooks ---

export const register: Register = (on, options) => {
  opts = options

  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    await registerTools($)
    startBridge($, e.cwd)
    const started = await next(e)
    await ensureInbox($)
    return started
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await ensureInbox($)
    return attached
  })

  // Restarts the inbox if it ended; a no-op while it runs.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await ensureInbox($)
    return next(e)
  })

  // The model is moot for both types (turn.step answers every request), but
  // a cheap one bounds the cost if a step ever falls through to the API.
  on('agent.spawn', async ($, e, next) => {
    if (e.resume) return next(e)
    if (e.subagentType === INBOX) return next({ ...e, model: 'haiku' })
    if (e.subagentType !== AGENT) return next(e)
    await awaitMeta()
    const { cfg, prompt } = takeSpawnCfg(e.prompt)
    const resolved = { ...cfg, ...resolveModel(cfg), cwd: cfg.cwd ?? e.cwd ?? null }
    const name = e.name ?? (await uniqueName($, undefined))
    spawnCfgByName.set(name, resolved)
    const started = await next({
      ...e,
      prompt: CODEX_TAG + prompt,
      model: 'haiku',
      description: `[${modelLabel(resolved)}] ${e.description}`,
    })
    if (started.agentId) await createBinding($, started.agentId, { name, parentAgentId: e.parentAgentId ?? null, cfg: resolved })
    return started
  })

  on('agent.offer', { agent: INBOX }, () => ({ isOffered: false }))

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined) return yield* next(e)
    const kind = await agentKind($, id)
    if (kind === 'codex') return yield* driveCodex($, e, await awaitBinding($, id), next.signal)
    if (kind === 'inbox') return yield* driveInbox($, e, id, next.signal)
    return yield* next(e)
  }).catch(async function* ($, e, next) {
    // Never let a Codex agent's or the inbox's step fall through to a Claude
    // model: answer with the failure instead.
    const isOurs = !!e.agentId && (await agentKind($, e.agentId)) !== null
    if (!isOurs) return yield* next(e)
    const answer = `codex-relay failed to run this Codex turn: ${next.error?.message ?? 'unknown error'}`
    yield { kind: 'text', index: 0, text: answer }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // A message for a Codex subagent while its Codex turn runs: steer it in.
  on('session.receive', async ($, e, next) => {
    if (!e.agentId) return next(e)
    const b = (await read($, bindings))[e.agentId]
    if (!b?.activeTurnId || !b.threadId) return next(e)
    try {
      await rpc($, 'turn/steer', { threadId: b.threadId, expectedTurnId: b.activeTurnId, input: [textInput(e.text)] })
      return { consumed: `steered into Codex thread ${b.threadId}` }
    } catch {
      return next(e)
    }
  })

  // SendMessage to "codex:<thread>" (or a Codex subagent's thread id).
  on('session.send', async ($, e, next) => {
    // To the inbox itself: unambiguous only while one thread awaits a reply.
    if (e.to === inboxName || inboxAgents.has(e.to)) {
      const waiting = Object.values(await read($, peers)).filter(p => p.isAwaitingReply)
      if (waiting.length !== 1)
        return { isDelivered: false, reason: 'codex-inbox only relays: SendMessage to "codex:<threadId>" (codex_list lists them).' }
      return next({ ...e, to: `codex:${waiting[0]!.threadId}` })
    }
    const all = await read($, bindings)
    const isCodexAddress = e.to.startsWith('codex:')
    const b = findBinding(all, e.to)
    if (b) {
      if (b.activeTurnId) {
        await sendToCodex($, b, e.text, await senderName($, e.agentId))
        return { isDelivered: true }
      }
      return e.to === b.agentId || e.to === b.name ? next(e) : next({ ...e, to: b.agentId })
    }
    if (!isCodexAddress) return next(e)
    const threadId = e.to.slice('codex:'.length)
    await api($, '/reply', { threadId, text: e.text, from: await senderName($, e.agentId) })
    await update($, peers, ps => (ps[threadId] ? { ...ps, [threadId]: { ...ps[threadId]!, isAwaitingReply: false } } : ps))
    return { isDelivered: true }
  })

  on('tool.call', { tool: 'mcp__codex-relay__codex_spawn' }, async ($, e) => {
    const input = e as unknown as {
      prompt: string
      model?: string
      effort?: string
      name?: string
      description?: string
      cwd?: string
      sandbox?: string
      wait?: boolean
    }
    await awaitMeta()
    if (input.model && models.length && !models.some(m => m.id === input.model))
      return { deny: `Unknown Codex model "${input.model}". Available: ${models.map(m => m.id).join(', ')}` }
    const token = Math.random().toString(36).slice(2, 10)
    pendingSpawns.set(token, {
      model: input.model ?? null,
      effort: input.effort ?? null,
      sandbox: input.sandbox ?? null,
      cwd: input.cwd ?? null,
    })
    const name = await uniqueName($, input.name)
    const spawned = await $.agent.spawn({
      subagentType: AGENT,
      prompt: `${MARK}${token}⁣\n${input.prompt}`,
      description: input.description ?? input.prompt.slice(0, 50),
      name,
    })
    if (spawned.deny !== undefined) return { deny: `Codex subagent not started: ${spawned.deny}` }
    const agentId = spawned.agentId!
    if (input.wait === false)
      return {
        result: `Started Codex subagent "${name}" in the background. You'll be notified when it finishes; SendMessage to "${name}" to message it meanwhile.`,
      }
    const answer = await waitForFirstAnswer($, agentId)
    // From module state: this hook's $.state read can trail the subagent's writes.
    const cfg = spawnCfgByName.get(name)
    const label = cfg ? modelLabel(cfg) : 'default model'
    return {
      result: `${answer}\n\n[Codex subagent "${name}" · ${label} · thread ${threadOfAgent.get(agentId) ?? '?'}. SendMessage to "${name}" to continue it.]`,
    }
  })

  on('tool.call', { tool: 'mcp__codex-relay__codex_send' }, async ($, e) => {
    const { to, text } = e as unknown as { to: string; text: string }
    const b = findBinding(await read($, bindings), to)
    const from = await senderName($, e.agentId)
    if (b) return { result: await sendToCodex($, b, text, from) }
    const threadId = to.replace(/^codex:/, '')
    const { how } = await api<{ how: string }>($, '/reply', { threadId, text, from })
    return {
      result:
        how === 'replied'
          ? 'Delivered: it was waiting on your reply.'
          : 'Queued in its mailbox; it reads it on its next claude_inbox or turn end.',
    }
  })

  on('tool.call', { tool: INBOX_WAIT }, async ($, e, next) => {
    if (!e.agentId || (await agentKind($, e.agentId)) !== 'inbox') return { deny: 'Only codex-relay’s inbox calls this.' }
    inboxAgents.add(e.agentId)
    return { result: await inboxWait($, next.signal) }
  })

  on('tool.call', { tool: 'mcp__codex-relay__codex_list' }, async $ => ({ result: await listText($) }))

  on('tool.call', { tool: 'mcp__codex-relay__codex_interrupt' }, async ($, e) => {
    const { to } = e as unknown as { to: string }
    const b = findBinding(await read($, bindings), to)
    if (!b) return { deny: `No Codex subagent "${to}".` }
    if (!b.activeTurnId || !b.threadId) return { result: `${b.name} is not running.` }
    await rpc($, 'turn/interrupt', { threadId: b.threadId, turnId: b.activeTurnId })
    return { result: `Interrupted ${b.name}.` }
  })

  on('command.run', { command: 'codex' }, async $ => ({ text: await listText($) }))
}
