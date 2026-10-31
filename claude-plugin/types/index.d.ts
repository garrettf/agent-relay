// One Codex thread running as a Claude subagent: the Claude-side agent loop
// (`agentId`) whose model steps the mod answers by driving `threadId`.
export type CodexBinding = {
  agentId: string
  /** What SendMessage addresses the subagent by. */
  name: string
  threadId: string | null
  model: string | null
  effort: string | null
  sandbox: string
  cwd: string
  /** The Claude loop that spawned it; null for the main conversation. */
  parentAgentId: string | null
  activeTurnId: string | null
  status: 'starting' | 'running' | 'idle' | 'error' | 'interrupted'
  /** Last thing Codex was seen doing, for the status line and pane. */
  activity: string
  createdAt: number
}

/** A Codex thread outside this session (e.g. open in the Codex app) that messaged Claude. */
export type ExternalPeer = {
  threadId: string
  name: string | null
  lastText: string
  at: number
  isAwaitingReply: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'codex-relay': {
      bindings: Shaped<Record<string, CodexBinding>>
      peers: Shaped<Record<string, ExternalPeer>>
    }
  }
}
