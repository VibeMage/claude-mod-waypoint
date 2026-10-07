export type WpTodo = { id: string; text: string; active: string; status: 'pending' | 'in_progress' | 'completed' }

// The session's /goal: its condition, and whether the evaluator found it met
export type WpGoal = { condition: string; isMet: boolean; reason?: string }

// One count of done out of total: a checklist section, a counter, an epic, a milestone
export type WpCount = {
  kind: 'checklist' | 'counter' | 'beads' | 'github'
  label: string
  done: number
  total: number
  detail?: string
  items?: { text: string; isDone: boolean }[]
}

export type WpPhase = { name: string; status: 'done' | 'active' | 'todo' }

export type WpAgentState = 'busy' | 'idle' | 'approval' | 'stuck' | 'unknown'

export type WpAgent = { pane: string; name: string; agent: string; state: WpAgentState; cwd: string }

export type WpLock = { label: string; actor: string; task?: string; since?: string; path: string }

export type WpSnapshot = {
  project: string
  isShown: boolean
  counts: WpCount[]
  phases: WpPhase[]
  current: number
  team: WpAgent[] | null
  locks: WpLock[]
  hasLocks: boolean
  problems: string[]
  configPath?: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    waypoint: { goal: WpGoal | null; todos: WpTodo[]; snapshot: WpSnapshot | null }
  }
}
