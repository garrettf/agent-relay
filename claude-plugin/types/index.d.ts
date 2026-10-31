// One Codex turn this session dispatched (create_thread, create_worktree_thread
// or send_message_to_thread) and has not yet reported.
export type CodexRun = {
  /** `${threadId}:${turnId}` */
  key: string
  threadId: string
  turnId: string
  title: string
  model: string | null
  effort: string | null
  startedAt: number
  /** The bridge's events socket (its `eventsSocket`), where the watcher waits. */
  socket: string
  /** The watcher agent's name, once spawned. */
  watcher: string | null
  /** Who gets the result: "main" or the dispatching subagent's name. */
  reportTo: string
}

declare module 'claude-code' {
  interface PluginState {
    'codex-relay': {
      runs: Record<string, CodexRun>
      /** Moved on by a timer while runs exist, so the band's elapsed times redraw. */
      now: number
    }
  }
}
