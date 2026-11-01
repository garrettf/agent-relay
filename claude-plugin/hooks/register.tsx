// codex-relay: the Claude side of Codex threads run through the bundled
// codex-thread-bridge MCP server (../codex-thread-bridge), which does the Codex
// work (create_thread, send_message_to_thread, steer_thread, ...).
//
// This mod watches those calls. Each dispatched turn gets:
//  - a row above the prompt: model, effort, elapsed time, a codex:// deeplink;
//  - a watcher subagent, listed as a running task while the turn runs, which
//    SendMessages the dispatcher Codex's final answer when the turn ends.
//
// A watcher exists because a real agent's SendMessage is the one way a mod can
// wake an idle main conversation without writing a user-role row. Nothing
// polls: its wait is one `$.http.fetch` that the bridge holds open until App
// Server pushes turn/completed (see events.py there).
//
// Only an agent spawned from inside a live hook gets this mod's turn.step, so
// watchers start in the dispatching call's tool.call hook.

import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionMessage,
  Timer,
  TurnStepChunk,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code'

import type { CodexRun } from '../types'

type $ = EngineInterface

const WATCHER = 'codex-relay:watcher'
const WATCH_TOOL = 'mcp__codex-relay__codex_watch'
// Starts a watcher's spawn prompt, so a reloaded module can tell its loops apart.
const WATCH_TAG = '⁣codex-relay-watch:'
const BRIDGE_TOOL = /^mcp__.*codex.*__(create_thread|create_worktree_thread|send_message_to_thread|wait_thread)$/
const CODEX_WORDS = /\b(codex|gpt[\s-]?\d[\w.]*|luna|sol|terra|astra)\b/i
// Prompts no person typed (agent messages, notifications): no routing note.
const NOT_TYPED = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'coordinator', 'observer', 'observer-activity', 'auto-continuation'])
const WAIT_MS = 10 * 60_000 // one watch call; the watcher then calls again
// $.http.fetch gives up on an answer after 30s, so a held request re-arms below that.
const HOLD_MS = 25_000
const TICK_MS = 1_000 // the band's running times count by the second
const MAX_ANSWER = 12_000
const KEEP_ENDED = 5 // finished turns the band keeps, for their deeplinks
const MAX_WAIT_ERRORS = 5 // in a row; a reload cancels one, a broken hook fails every one

const runs = atom({ plugin: 'codex-relay', key: 'runs' } as const, {} as Record<string, CodexRun>)
const now = atom({ plugin: 'codex-relay', key: 'now' } as const, 0)

let sessionCwd = ''
let ticker: Timer | null = null
const watcherRun = new Map<string, string | null>() // agentId -> run key (null: not a watcher)

// ------------------------------------------------------------------ runs ---

type Ended = {
  threadId: string
  turnId: string
  status: string
  error: unknown
  durationMs: number | null
  finalMessage: string | null
}

function parseJson(text: string | undefined): any {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

const EFFORT: Record<string, string> = { medium: 'med' }

function modelLabel(r: Pick<CodexRun, 'model' | 'effort'>): string {
  return [r.model ?? 'default model', r.effort && (EFFORT[r.effort] ?? r.effort)].filter(Boolean).join(' ')
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function deeplink(threadId: string): string {
  return `codex://threads/${threadId}`
}

// Desktop draws only https: links, so the band opens the deeplink from the host.
async function openInCodex($: $, threadId: string) {
  const { exitCode, stderr } = await $.process.run(['open', deeplink(threadId)], { timeoutMs: 10_000 })
  if (exitCode !== 0) $.ui.toast(`codex-relay: could not open the Codex app: ${stderr.trim()}`)
}

async function refresh($: $) {
  const list = Object.values(await read($, runs)).filter(r => r.endedAt == null)
  const t = await $.clock.now()
  await update($, now, () => t)
  if (!list.length) {
    ticker?.cancel()
    ticker = null
    $.ui.status(undefined)
    return
  }
  const first = list[0]!
  $.ui.status(
    list.length === 1
      ? `codex: ${modelLabel(first)} · ${elapsed(t - first.startedAt)}`
      : `codex: ${list.length} running`,
  )
  ticker ??= $.clock.every(TICK_MS, () => void refresh($))
}

async function dropRun($: $, key: string) {
  await update($, runs, all => {
    const { [key]: _, ...rest } = all
    return rest
  })
  await refresh($)
}

// The band keeps a finished turn (and its deeplink) until cleared or pushed out.
async function endRun($: $, key: string, status: string) {
  const t = await $.clock.now()
  await update($, runs, all => {
    if (!all[key] || all[key]!.endedAt != null) return all
    const next = { ...all, [key]: { ...all[key]!, endedAt: t, status } }
    const ended = Object.values(next)
      .filter(r => r.endedAt != null)
      .sort((a, b) => b.endedAt! - a.endedAt!)
    for (const r of ended.slice(KEEP_ENDED)) delete next[r.key]
    return next
  })
  await refresh($)
}

// A running turn is never cleared: its watcher reads the run to decide whether to report.
async function clearEnded($: $, key: string) {
  await update($, runs, all => {
    if (all[key]?.endedAt == null) return all
    const { [key]: _, ...rest } = all
    return rest
  })
}

// The model's input names a title or a prompt; either makes a readable name.
function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .split('-')
      .filter(Boolean)
      .slice(0, 3)
      .join('-') || 'thread'
  )
}

async function uniqueName($: $, base: string): Promise<string> {
  const taken = new Set((await $.agent.list()).map(a => a.name).filter(Boolean))
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
  return name
}

async function nameOf($: $, agentId: string | undefined): Promise<string> {
  if (!agentId) return 'main'
  return (await $.agent.list()).find(a => a.id === agentId)?.name ?? 'main'
}

// After a bridge call that dispatched a turn: track it and start its watcher.
async function trackDispatch($: $, e: any, receipt: any): Promise<string | null> {
  if (receipt?.status !== 'accepted' || !receipt.turnId || !receipt.threadId || !receipt.eventsSocket) return null
  const known = (await read($, runs))[`${receipt.threadId}:${receipt.turnId}`]
  if (known) return known.watcher // a replayed receipt
  const run: CodexRun = {
    key: `${receipt.threadId}:${receipt.turnId}`,
    threadId: receipt.threadId,
    turnId: receipt.turnId,
    title: String(e.title || receipt.title || String(e.prompt ?? e.message ?? '').slice(0, 60) || 'Codex thread'),
    model: receipt.model ?? null,
    effort: receipt.reasoningEffort ?? null,
    startedAt: await $.clock.now(),
    socket: receipt.eventsSocket,
    watcher: null,
    reportTo: await nameOf($, e.agentId),
  }
  await update($, runs, all => ({ ...all, [run.key]: run }))
  const name = await uniqueName($, `codex-${slug(run.title)}`)
  const spawned = await $.agent.spawn({
    subagentType: WATCHER,
    prompt: `${WATCH_TAG}${run.key}\nReports Codex thread ${run.threadId} turn ${run.turnId} to ${run.reportTo}.`,
    description: `[${modelLabel(run)}] ${run.title}`,
    name,
  })
  if (spawned.deny !== undefined) {
    $.ui.toast(`codex-relay: no watcher for "${run.title}": ${spawned.deny}`)
    await dropRun($, run.key)
    return null
  }
  watcherRun.set(spawned.agentId!, run.key)
  await update($, runs, all => (all[run.key] ? { ...all, [run.key]: { ...all[run.key]!, watcher: name } } : all))
  await refresh($)
  return name
}

// ------------------------------------------------------------- watchers ---

async function rowsOf($: $, agentId: string): Promise<SessionMessage[]> {
  const rows = await $.session.messages({ agentId })
  return Array.isArray(rows) ? rows : []
}

async function runKeyOf($: $, agentId: string): Promise<string | null> {
  if (watcherRun.has(agentId)) return watcherRun.get(agentId)!
  const first = (await rowsOf($, agentId)).find(m => m.role === 'user')?.text ?? ''
  const key = first.startsWith(WATCH_TAG) ? first.slice(WATCH_TAG.length).split('\n')[0]! : null
  watcherRun.set(agentId, key)
  return key
}

function toolUseId(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let id = 'toolu_01'
  for (let i = 0; i < 22; i++) id += abc[Math.floor(Math.random() * abc.length)]
  return id
}

function* callTool(e: TurnStepInput, name: string, input: Record<string, unknown>): Generator<TurnStepChunk, TurnStepResult> {
  yield { kind: 'tool', index: 0, id: toolUseId(), name }
  yield { kind: 'input', index: 0, json: JSON.stringify(input) }
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name, input }], stopReason: 'tool_use', usage: null }
}

function* say(e: TurnStepInput, answer: string): Generator<TurnStepChunk, TurnStepResult> {
  yield { kind: 'text', index: 0, text: answer }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
}

function report(run: CodexRun | undefined, ended: Ended): string {
  const title = run ? `"${run.title}" (${modelLabel(run)})` : ended.threadId
  const took = ended.durationMs != null ? ` in ${elapsed(ended.durationMs)}` : ''
  let answer = ended.finalMessage ?? '(no final message)'
  if (answer.length > MAX_ANSWER) answer = `${answer.slice(0, MAX_ANSWER)}\n… (clipped; read_thread has the rest)`
  const error = ended.error ? `\nError: ${JSON.stringify(ended.error)}` : ''
  return [
    `Codex thread ${title} ${ended.status}${took}:${error}`,
    '',
    answer,
    '',
    `thread_id ${ended.threadId} · turn_id ${ended.turnId} · ${deeplink(ended.threadId)}`,
    'Continue it with send_message_to_thread.',
  ].join('\n')
}

// A watcher's steps: wait (a tool call), then SendMessage the result, then
// end with a line of text. Each step reads where it is from the transcript,
// so a reload between steps loses nothing.
async function* driveWatcher($: $, e: TurnStepInput, agentId: string, key: string) {
  const rows = await rowsOf($, agentId)
  const uses = rows.flatMap(r => (r.role === 'assistant' ? r.toolUses : []))
  const lastUse = uses[uses.length - 1]
  let errors = 0
  while (errors < uses.length && uses[uses.length - 1 - errors]!.tool === WATCH_TOOL && uses[uses.length - 1 - errors]!.isError) errors++
  const run = (await read($, runs))[key]
  if (lastUse?.tool === 'SendMessage') return yield* say(e, `Reported to ${String(lastUse.input.to)}.`)
  // A wait cancelled by a reload has an error result: wait again.
  const outcome = lastUse?.tool === WATCH_TOOL && !lastUse.isError ? parseJson(lastUse.text) : null
  if (outcome?.isSeen) return yield* say(e, 'The dispatcher already read this result.')
  const ended: Ended | undefined = outcome?.ended?.[0]
  const failure: string | undefined =
    outcome?.error ?? (errors >= MAX_WAIT_ERRORS ? `its wait failed ${errors} times: ${lastUse?.text ?? ''}` : undefined)
  if (!ended && !failure) return yield* callTool(e, WATCH_TOOL, {})
  await endRun($, key, ended?.status ?? 'lost')
  const to = run?.reportTo ?? 'main'
  const message = ended
    ? report(run, ended)
    : `codex-relay lost track of Codex thread ${run?.threadId ?? key} (${failure}). Check it with wait_thread or read_thread.`
  const summary = ended
    ? `${run?.title ?? 'Codex'} ${ended.status}: ${(ended.finalMessage ?? '').slice(0, 60)}`
    : `lost track of ${run?.title ?? 'a Codex turn'}`
  return yield* callTool(e, 'SendMessage', { to, message, summary })
}

// The turn then ends as `interrupted`, which its watcher reports like any other end.
async function stopRun($: $, run: CodexRun) {
  let error: string | undefined
  try {
    const res = await $.http.fetch(`http://codex/interrupt?turn=${encodeURIComponent(run.key)}`, {
      method: 'POST',
      socketPath: run.socket,
    })
    if (!res.ok) error = parseJson(res.text)?.error ?? `HTTP ${res.status}`
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  if (error) $.ui.toast(`codex-relay: could not stop ${run.title}: ${error}`)
}

// The watcher's wait: answers once the turn ends, or after WAIT_MS.
async function watch($: $, key: string): Promise<string> {
  const until = (await $.clock.now()) + WAIT_MS
  while ((await $.clock.now()) < until) {
    const run = (await read($, runs))[key]
    if (!run || run.endedAt != null) return JSON.stringify({ isSeen: true })
    let res
    try {
      res = await $.http.fetch(`http://codex/wait?turns=${encodeURIComponent(key)}&timeoutMs=${HOLD_MS}`, {
        socketPath: run.socket,
      })
    } catch (err) {
      return JSON.stringify({ error: `the bridge is unreachable: ${err instanceof Error ? err.message : err}` })
    }
    const body = parseJson(res.text)
    if (!res.ok) return JSON.stringify({ error: body?.error ?? `HTTP ${res.status}` })
    if (body?.ended?.length) {
      const after = (await read($, runs))[key]
      return JSON.stringify(after && after.endedAt == null ? body : { isSeen: true })
    }
  }
  return JSON.stringify({ ended: [] })
}

// ---------------------------------------------------------------- the UI ---

function band($: $, e: any, list: CodexRun[], t: number) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const running = list.filter(r => r.endedAt == null)
  const ended = list.filter(r => r.endedAt != null).sort((a, b) => b.endedAt! - a.endedAt!)
  return (
    // Buttons are taller than a line of text: center each row and space them.
    <Box flexDirection="column" gap="xs">
      {[...running, ...ended].map(r => {
        const [mark, color] =
          r.endedAt == null ? ['◐', 'claude'] : r.status === 'completed' ? ['✓', 'success'] : ['✗', 'error']
        return (
          <Box key={r.key} flexDirection="row" alignItems="center" gap="sm">
            {/* The marks differ in glyph width; a fixed cell keeps the titles aligned. */}
            <Box width={2} flexShrink={0} justifyContent="center">
              <Text color={color}>{mark}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text dimColor>{`${r.title} · `}</Text>
                <Text color="suggestion">{modelLabel(r)}</Text>
              </Text>
            </Box>
            <Text tabular dimColor>
              {elapsed((r.endedAt ?? t) - r.startedAt)}
            </Text>
            <Button key={`open-${r.key}`} label="Open" dimColor onPress={() => openInCodex($, r.threadId)} />
            {r.endedAt == null ? (
              <Button key={`stop-${r.key}`} label="■" plain dimColor onPress={() => stopRun($, r)} />
            ) : (
              <Button key={`clear-${r.key}`} label="✕" plain dimColor onPress={() => clearEnded($, r.key)} />
            )}
          </Box>
        )
      })}
    </Box>
  )
}

// ------------------------------------------------------------- the hooks ---

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    await $.agent.register({
      name: 'watcher',
      description: 'Internal to codex-relay: watches one Codex turn and reports its result. Started by the mod, never by hand.',
      prompt: 'This agent is served by the codex-relay mod; its steps never reach the Anthropic API.',
      tools: ['SendMessage', WATCH_TOOL],
      model: 'haiku',
    })
    await $.tool.register({
      name: 'codex_watch',
      isDeferred: true,
      description: 'Internal to codex-relay’s watcher agents; refused to anyone else.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    })
    const started = await next(e)
    await refresh($)
    return started
  })

  // Plain language ("a luna medium subagent") reaches the bridge: a prompt
  // that names a Codex model carries a note the model reads beside it.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || NOT_TYPED.has(e.origin.kind) || !CODEX_WORDS.test(e.text)) return next(e)
    const note = [
      'codex-relay: this message may name an OpenAI Codex model. Work for a Codex/GPT model (a "luna/sol/terra subagent", "ask codex", gpt-…) runs through the mcp__plugin_codex-relay_codex__create_thread tool (load it with ToolSearch if deferred), never the Agent tool, which runs Claude models alone.',
      `Pass request_id (a fresh unique string), cwd ("${sessionCwd}" unless another is meant), a self-contained prompt (Codex sees none of this conversation), a short title, model as named (a family name like "luna" means its newest model) and reasoning_effort as named (low/medium/high/xhigh/max).`,
      'sandbox defaults to read-only; pass workspace-write if it must edit files.',
      'Do not call wait_thread: codex-relay messages you Codex’s final answer when the turn ends. Follow up with send_message_to_thread.',
    ].join(' ')
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('agent.spawn', async ($, e, next) => {
    // The model is moot (turn.step answers every request); a cheap one bounds
    // the cost if a step ever falls through to the API.
    if (!e.resume && e.subagentType === WATCHER) return next({ ...e, model: 'haiku' })
    return next(e)
  })

  on('agent.offer', { agent: WATCHER }, () => ({ isOffered: false }))

  on('turn.step', async function* ($, e, next) {
    const key = e.agentId ? await runKeyOf($, e.agentId) : null
    if (!key) return yield* next(e)
    return yield* driveWatcher($, e, e.agentId!, key)
  }).catch(async function* ($, e, next) {
    // Never let a watcher's step fall through to a Claude model.
    if (!e.agentId || !(await runKeyOf($, e.agentId))) return yield* next(e)
    return yield* say(e, `codex-relay's watcher failed: ${next.error?.message ?? 'unknown error'}`)
  })

  // A watcher only reports: point a message for it at the bridge's tools.
  on('session.send', async ($, e, next) => {
    const watcher = Object.values(await read($, runs)).find(r => r.watcher === e.to)
    if (!watcher) return next(e)
    return {
      isDelivered: false,
      reason: `${e.to} only reports Codex thread ${watcher.threadId}. Message Codex itself: steer_thread (thread_id ${watcher.threadId}, expected_turn_id ${watcher.turnId}) while it runs, send_message_to_thread once it is idle.`,
    }
  })

  // A registered tool is answered only by a hook whose matcher names it. (The
  // cast: typed tool names are the tools seen at the last load, which trail it.)
  on('tool.call', { tool: WATCH_TOOL as 'SendMessage' }, async ($, e) => {
    const key = e.agentId ? await runKeyOf($, e.agentId) : null
    if (!key) return { deny: 'Only codex-relay’s watcher agents call this.' }
    return { result: await watch($, key) }
  })

  on('tool.call', async ($, e, next) => {
    const tool = BRIDGE_TOOL.exec(e.tool)?.[1]
    if (!tool) return next(e)
    const result = await next(e)
    if (result.deny !== undefined || result.isError) return result
    const body = parseJson(result.text)
    if (tool === 'wait_thread') {
      // The dispatcher has the result itself: its watcher ends without a message.
      if (body && !body.timedOut) await endRun($, `${body.threadId}:${body.turnId}`, body.turn?.status ?? 'ended')
      return result
    }
    const watcher = await trackDispatch($, e, body)
    if (!watcher) return result
    const note = `codex-relay: ${watcher} is watching this turn and will message you Codex’s final answer when it ends; do not call wait_thread. Carry on, or end your turn to wait.`
    return { ...result, context: [...(result.context ?? []), note] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = Object.values(await read($, runs))
    if (!list.length) return next(e)
    return band($, e, list, await read($, now))
  })
}
