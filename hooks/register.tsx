import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WpAgent, WpCount, WpGoal, WpLock, WpPhase, WpSnapshot, WpTodo } from '../types'
import {
  APPROVAL_PATTERNS,
  STUCK_PATTERNS,
  bar,
  clipWidth,
  currentPhase,
  displayWidth,
  fitSegments,
  hasCjk,
  isUnder,
  latestGoal,
  normalizePane,
  paneState,
  phaseShort,
  pickSection,
  replayTodo,
  roadmapPhases,
} from './parse'

const PANE = 'waypoint'

// Sources: the project's files, Otty, lock files and trackers, all read-only

export type ChecklistSource = { file: string; section?: string; marker?: string; label?: string }
export type CounterSource = { label: string; done?: number; total?: number; command?: string[] }
export type LockSource = { path: string; label?: string; worktrees?: boolean }

export type ProjectConfig = {
  name?: string
  root?: string
  paths?: string[]
  panes?: string[]
  checklists?: ChecklistSource[]
  roadmap?: { file?: string; current?: string } | false
  counters?: CounterSource[]
  beads?: { epic?: string } | boolean
  github?: { milestone?: string } | boolean
  team?: { panes?: Record<string, string>; cwds?: string[]; agents?: string[]; stuck?: string[] } | false
  locks?: LockSource[]
}

type Resolved = { cfg: ProjectConfig; root: string; path?: string; problems: string[] }

const SLOW_MS = 5 * 60_000
const WORKTREE_MS = 60_000

// Results of the slow sources (bd, gh, git worktree), kept between refreshes in the module
const cache = new Map<string, { at: number; value: unknown }>()

async function cached<T>(key: string, ttl: number, now: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && now - hit.at < ttl) return hit.value as T
  const value = await load()
  cache.set(key, { at: now, value })

  return value
}

function expand(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}

function join(root: string, path: string): string {
  return path.startsWith('/') ? path : `${root.replace(/\/+$/, '')}/${path}`
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  return JSON.parse(await $.fs.read(path))
}

async function run($: EngineInterface, argv: string[], cwd: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { cwd, timeoutMs })
    return exitCode === 0 ? stdout : null
  } catch {
    return null
  }
}

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

// The project's own `.claude/waypoint.json`, else the entry of `~/.claude/waypoint.json` whose paths hold the session
async function resolveConfig($: EngineInterface, homeDir: string): Promise<Resolved> {
  const problems: string[] = []
  const cwd = await $.session.cwd()
  const root = await $.session.root().catch(() => cwd)

  const own = `${root}/.claude/waypoint.json`
  if (await $.fs.exists(own).catch(() => false)) {
    try {
      const cfg = (await readJson($, own)) as ProjectConfig
      return { cfg, root: cfg.root ? expand(cfg.root, homeDir) : root, path: own, problems }
    } catch (err) {
      problems.push(`${own}: ${String(err)}`)
    }
  }

  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${homeDir}/.claude`
  const global = `${configDir}/waypoint.json`
  if (await $.fs.exists(global).catch(() => false)) {
    try {
      const file = (await readJson($, global)) as { projects?: ProjectConfig[] }
      for (const cfg of file.projects ?? []) {
        const paths = (cfg.paths ?? (cfg.root ? [cfg.root] : [])).map(p => expand(p, homeDir))
        if (paths.some(p => isUnder(cwd, p) || isUnder(root, p))) {
          return { cfg, root: cfg.root ? expand(cfg.root, homeDir) : (paths[0] ?? root), path: global, problems }
        }
      }
    } catch (err) {
      problems.push(`${global}: ${String(err)}`)
    }
  }

  return { cfg: {}, root, problems }
}

async function checklistCounts($: EngineInterface, cfg: ProjectConfig, root: string, problems: string[]): Promise<WpCount[]> {
  let sources = cfg.checklists
  if (!sources) {
    // No config: the first conventional file that holds checkboxes
    for (const file of ['TODO.md', 'docs/TODO.md', 'ROADMAP.md', 'docs/ROADMAP.md', 'PLAN.md', 'docs/PLAN.md']) {
      const text = await $.fs.read(join(root, file)).catch(() => null)
      if (text && /^[-*+] \[[ xX]\]/m.test(text)) {
        sources = [{ file }]
        break
      }
    }
  }
  const out: WpCount[] = []
  for (const src of sources ?? []) {
    const text = await $.fs.read(join(root, src.file)).catch(() => null)
    if (text === null) {
      problems.push(`${src.file}: not found`)
      continue
    }
    const name = src.file.split('/').pop()!.replace(/\.md$/i, '')
    const section = pickSection(text, src, name)
    if (!section) {
      if (src.section) problems.push(`${src.file}: no section "${src.section}"`)
      continue
    }
    out.push({
      kind: 'checklist',
      label: src.label ?? section.label,
      done: section.done,
      total: section.total,
      detail: src.file,
      items: section.items,
    })
  }

  return out
}

async function roadmap($: EngineInterface, cfg: ProjectConfig, root: string): Promise<{ phases: WpPhase[]; current: number }> {
  if (cfg.roadmap === false) return { phases: [], current: -1 }
  const files = cfg.roadmap?.file ? [cfg.roadmap.file] : ['ROADMAP.md', 'docs/ROADMAP.md']
  for (const file of files) {
    const text = await $.fs.read(join(root, file)).catch(() => null)
    if (text === null) continue
    const phases = roadmapPhases(text)
    if (phases.length > 0) return { phases, current: currentPhase(phases, cfg.roadmap?.current) }
  }

  return { phases: [], current: -1 }
}

async function counters($: EngineInterface, cfg: ProjectConfig, root: string, problems: string[]): Promise<WpCount[]> {
  const out: WpCount[] = []
  for (const c of cfg.counters ?? []) {
    if (c.command) {
      const stdout = await run($, c.command, root)
      const m = stdout?.match(/(\d+)\s*\/\s*(\d+)/)
      if (!m) {
        problems.push(`${c.label}: the command printed no "done/total"`)
        continue
      }
      out.push({ kind: 'counter', label: c.label, done: Number(m[1]), total: Number(m[2]) })
    } else if (typeof c.done === 'number' && typeof c.total === 'number') {
      out.push({ kind: 'counter', label: c.label, done: c.done, total: c.total })
    }
  }

  return out
}

type BeadsEpic = {
  epic: { id: string; title: string; status: string; updated_at?: string }
  total_children: number
  closed_children: number
}

async function beads($: EngineInterface, cfg: ProjectConfig, root: string, now: number): Promise<WpCount[]> {
  if (cfg.beads === false) return []
  if (cfg.beads === undefined && !(await $.fs.exists(`${root}/.beads`).catch(() => false))) return []
  const epics = await cached(`bd:${root}`, SLOW_MS, now, async () => {
    const stdout = await run($, ['bd', 'epic', 'status', '--json'], root, 15_000)
    try {
      return stdout ? (JSON.parse(stdout) as BeadsEpic[]) : []
    } catch {
      return []
    }
  })
  const pinned = typeof cfg.beads === 'object' ? cfg.beads.epic : undefined
  const open = epics.filter(e => (pinned ? e.epic.id === pinned : e.epic.status !== 'closed'))

  return open.slice(0, pinned ? 1 : 2).map(e => ({
    kind: 'beads',
    label: e.epic.title,
    done: e.closed_children,
    total: e.total_children,
    detail: `beads ${e.epic.id}`,
  }))
}

type Milestone = { title: string; open_issues: number; closed_issues: number; due_on?: string | null }

async function github($: EngineInterface, cfg: ProjectConfig, root: string, now: number): Promise<WpCount[]> {
  if (!cfg.github) return []
  const list = await cached(`gh:${root}`, SLOW_MS, now, async () => {
    const stdout = await run($, ['gh', 'api', 'repos/{owner}/{repo}/milestones?state=open'], root, 15_000)
    try {
      return stdout ? (JSON.parse(stdout) as Milestone[]) : []
    } catch {
      return []
    }
  })
  const wanted = typeof cfg.github === 'object' ? cfg.github.milestone : undefined
  const pick = wanted ? list.find(m => m.title === wanted) : list[0]
  if (!pick) return []

  return [
    {
      kind: 'github',
      label: pick.title,
      done: pick.closed_issues,
      total: pick.open_issues + pick.closed_issues,
      detail: 'GitHub milestone',
    },
  ]
}

async function worktrees($: EngineInterface, root: string, now: number): Promise<string[]> {
  return cached(`wt:${root}`, WORKTREE_MS, now, async () => {
    const stdout = await run($, ['git', 'worktree', 'list', '--porcelain'], root)
    const list = (stdout ?? '')
      .split('\n')
      .filter(l => l.startsWith('worktree '))
      .map(l => l.slice(9))

    return list.length > 0 ? list : [root]
  })
}

type OttyPane = { id: string; agent?: string; agent_state?: string; cwd?: string; process?: string }

// `✳ Fix the build` → `Fix the build`: Otty's title keeps the agent's spinner glyph in front
function paneName(pane: OttyPane): string {
  const title = (pane.process ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim()

  return title || pane.agent || pane.id
}

async function team(
  $: EngineInterface,
  cfg: ProjectConfig,
  root: string,
  self: string | undefined,
  homeDir: string,
  dirs: string[],
): Promise<WpAgent[] | null> {
  if (cfg.team === false || !self) return null
  const stdout = await run($, ['otty', 'pane', 'list', '--json'], root, 4000)
  if (!stdout) return null
  let panes: OttyPane[] = []
  try {
    const parsed = JSON.parse(stdout) as { data?: OttyPane[] | { panes?: OttyPane[] } }
    panes = Array.isArray(parsed.data) ? parsed.data : (parsed.data?.panes ?? [])
  } catch {
    return null
  }
  const named = cfg.team?.panes
  const agents = cfg.team?.agents ?? ['Claude Code', 'Codex']
  const places = [...dirs, ...(cfg.team?.cwds ?? []).map(d => expand(d, homeDir))]
  const members = panes.filter(p =>
    named
      ? p.id in named
      : p.id !== self && agents.includes(p.agent ?? '') && places.some(d => isUnder(p.cwd ?? '', d)),
  )
  const stuck = cfg.team?.stuck ?? STUCK_PATTERNS

  return Promise.all(
    members.map(async p => {
      const screen = (await run($, ['otty', 'pane', 'capture', '--pane', p.id, '--lines', '12', '--trim'], root, 3000)) ?? ''
      return {
        pane: p.id,
        name: named?.[p.id] ?? paneName(p),
        agent: p.agent ?? '',
        state: paneState(p.agent_state ?? '', screen, stuck, APPROVAL_PATTERNS, p.agent ?? ''),
        cwd: p.cwd ?? '',
      }
    }),
  )
}

async function locks($: EngineInterface, cfg: ProjectConfig, root: string, homeDir: string, dirs: string[]): Promise<WpLock[]> {
  const out: WpLock[] = []
  const seen = new Set<string>()
  for (const src of cfg.locks ?? []) {
    const path = expand(src.path, homeDir)
    const candidates = src.worktrees && !path.startsWith('/') ? dirs.map(d => join(d, path)) : [join(root, path)]
    for (const candidate of candidates) {
      const stat = await $.fs.stat(candidate, { resolve: true }).catch(() => undefined)
      if (!stat) continue
      const real = stat.realPath ?? candidate
      if (seen.has(real)) continue
      seen.add(real)
      // A lock directory names its holder in owner.json; a lock file is JSON itself or held by being there
      const file = stat.kind === 'dir' ? `${candidate}/owner.json` : candidate
      let info: Record<string, unknown> = {}
      try {
        info = (await readJson($, file)) as Record<string, unknown>
      } catch {
        // Held, holder unnamed
      }
      const str = (...keys: string[]) => {
        for (const k of keys) if (typeof info[k] === 'string' && info[k]) return info[k] as string
        return undefined
      }
      out.push({
        label: src.label ?? path.split('/').filter(Boolean).pop() ?? 'lock',
        actor: str('actor', 'owner', 'holder', 'user', 'agent') ?? '?',
        task: str('task', 'issue', 'ticket'),
        since: str('utc', 'since', 'time', 'created_at', 'acquired_at'),
        path: candidate,
      })
    }
  }

  return out
}

// The last /goal the transcript holds: the evaluator's goal_status record, or the command itself
async function readGoal($: EngineInterface, transcript: string | undefined): Promise<WpGoal | null | undefined> {
  if (!transcript) return undefined
  const stdout = await run($, ['grep', '-E', '"goal_status"|<command-name>/goal<', transcript], '/', 4000)
  if (stdout === null) return null
  return latestGoal(stdout.split('\n'))
}

// The session's transcript file: `<config>/projects/<cwd with every non-alphanumeric as ->/<session id>.jsonl`
async function transcriptPath($: EngineInterface, homeDir: string): Promise<string | undefined> {
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${homeDir}/.claude`
  const id = await $.session.id()
  const cwd = await $.session.cwd()
  const guess = `${configDir}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
  if (await $.fs.exists(guess).catch(() => false)) return guess
  const found = await run($, ['find', `${configDir}/projects`, '-maxdepth', '2', '-name', `${id}.jsonl`], '/', 5000)

  return found?.split('\n').find(Boolean)
}

async function collect($: EngineInterface, homeDir: string, self: string | undefined): Promise<WpSnapshot> {
  const now = await $.clock.now()
  const { cfg, root, path, problems } = await resolveConfig($, homeDir)
  const dirs = await worktrees($, root, now)
  const [checklists, road, counts, epics, milestones, members, held] = await Promise.all([
    checklistCounts($, cfg, root, problems),
    roadmap($, cfg, root),
    counters($, cfg, root, problems),
    beads($, cfg, root, now),
    github($, cfg, root, now),
    team($, cfg, root, self, homeDir, dirs),
    locks($, cfg, root, homeDir, dirs),
  ])

  return {
    project: cfg.name ?? root.split('/').filter(Boolean).pop() ?? root,
    isShown: !cfg.panes || (self !== undefined && cfg.panes.map(normalizePane).includes(self)),
    counts: [...checklists, ...counts, ...epics, ...milestones],
    phases: road.phases,
    current: road.current,
    team: members,
    locks: held,
    hasLocks: (cfg.locks ?? []).length > 0,
    problems,
    configPath: path,
    at: now,
  }
}

const goal = atom({ plugin: 'waypoint', key: 'goal' } as const, null)
const todos = atom({ plugin: 'waypoint', key: 'todos' } as const, [])
const snapshot = atom({ plugin: 'waypoint', key: 'snapshot' } as const, null)

type Palette = {
  text: string
  subtext: string
  overlay: string
  fill: string
  track: string
  blue: string
  green: string
  orange: string
  red: string
  indigo: string
}

// Apple's system colours (HIG), the accents at their increased-contrast values so they read on a fill
const CUPERTINO: Record<'light' | 'dark', Palette> = {
  light: {
    text: '#1d1d1f',
    subtext: '#6e6e73',
    overlay: '#8e8e93',
    fill: '#ececf0',
    track: '#c7c7cc',
    blue: '#0071e3',
    green: '#248a3d',
    orange: '#c93400',
    red: '#d70015',
    indigo: '#5e5ce6',
  },
  dark: {
    text: '#f5f5f7',
    subtext: '#98989f',
    overlay: '#7c7c80',
    fill: '#2c2c2e',
    track: '#48484a',
    blue: '#0a84ff',
    green: '#30d158',
    orange: '#ff9f0a',
    red: '#ff453a',
    indigo: '#7d7aff',
  },
}

const WORDS = {
  en: {
    goal: 'Goal',
    met: 'met',
    todos: 'todos',
    team: 'agents',
    busy: 'busy',
    idle: 'idle',
    approval: 'approval',
    stuck: 'stuck',
    unknown: '?',
    lock: 'lock',
    free: 'free',
    roadmap: 'Roadmap',
    checklists: 'Progress',
    locks: 'Locks',
    problems: 'Notes',
    noConfig: 'No waypoint.json: showing what was found. /waypoint config shows how to add one.',
    nothing: 'Nothing to track yet: no /goal, todos, checklist or roadmap found.',
  },
  zh: {
    goal: '目标',
    met: '已达成',
    todos: '任务',
    team: '团队',
    busy: '忙',
    idle: '闲',
    approval: '待批',
    stuck: '卡',
    unknown: '?',
    lock: '锁',
    free: '无',
    roadmap: '路线图',
    checklists: '进度',
    locks: '锁',
    problems: '提示',
    noConfig: '没有 waypoint.json，只显示自动找到的内容。/waypoint config 查看配置方法。',
    nothing: '还没有可跟踪的内容：没有 /goal、任务清单、勾选清单或路线图。',
  },
} as const

type Lang = keyof typeof WORDS
type Words = (typeof WORDS)[Lang]

type Config = { language: 'auto' | Lang; refreshSeconds: number; style: 'capsule' | 'plain'; showTeam: boolean }

export function readConfig(options: Record<string, unknown>): Config {
  const n = Number(options.refreshSeconds)

  return {
    language: options.language === 'en' || options.language === 'zh' ? options.language : 'auto',
    refreshSeconds: Number.isFinite(n) ? Math.min(600, Math.max(5, Math.round(n))) : 20,
    style: options.style === 'plain' ? 'plain' : 'capsule',
    showTeam: options.showTeam !== false,
  }
}

async function palette($: EngineInterface): Promise<Palette> {
  try {
    return String((await $.settings.read()).theme ?? 'dark').includes('light') ? CUPERTINO.light : CUPERTINO.dark
  } catch {
    return CUPERTINO.dark
  }
}

function language(cfg: Config, s: WpSnapshot | null, g: WpGoal | null, list: WpTodo[], lang: string): Lang {
  if (cfg.language !== 'auto') return cfg.language
  if (lang.toLowerCase().startsWith('zh')) return 'zh'
  const seen = [g?.condition ?? '', ...list.map(t => t.text), ...(s?.counts ?? []).map(c => c.label), ...(s?.phases ?? []).map(p => p.name)]

  return seen.some(hasCjk) ? 'zh' : 'en'
}

type Part = { text: string; color: string; bold?: boolean }
type Segment = { key: string; priority: number; width: number; parts: Part[] }

function segment(key: string, priority: number, parts: Part[]): Segment {
  return { key, priority, parts, width: parts.reduce((w, p) => w + displayWidth(p.text), 0) + 2 }
}

// A checklist, epic or milestone gets a five-cell bar; a counter, usually a long tally, its figures alone
function countParts(c: WpCount, p: Palette, labelMax: number, withBar = c.kind !== 'counter'): Part[] {
  const isDone = c.total > 0 && c.done >= c.total
  const b = withBar ? bar(c.done, c.total) : { filled: '', empty: '' }

  return [
    { text: isDone ? '✓ ' : '', color: p.green },
    { text: clipWidth(c.label, labelMax), color: p.text },
    { text: withBar ? ' ' : '', color: p.text },
    { text: b.filled, color: isDone ? p.green : p.blue },
    { text: b.empty, color: p.track },
    { text: ` ${c.done}/${c.total}`, color: p.subtext },
  ].filter(part => part.text !== '')
}

function teamTally(team: WpAgent[]) {
  const by = (s: WpAgent['state']) => team.filter(a => a.state === s).length

  return { busy: by('busy'), stuck: by('stuck'), approval: by('approval') }
}

// The band's segments, most important first in priority; the fit drops the lowest when the row is short
export function bandSegments(s: WpSnapshot | null, g: WpGoal | null, list: WpTodo[], p: Palette, w: Words, showTeam: boolean): Segment[] {
  const out: Segment[] = []
  const done = list.filter(t => t.status === 'completed').length
  const tally = list.length > 0 ? `${done}/${list.length}` : ''

  if (g) {
    out.push(
      segment('goal', 100, [
        { text: g.isMet ? '✓ ' : '◎ ', color: g.isMet ? p.green : p.indigo },
        { text: clipWidth(g.condition, 26), color: p.text, bold: true },
        ...(g.isMet ? [{ text: ` ${w.met}`, color: p.green }] : []),
        ...(tally && !g.isMet ? [{ text: ` ${tally}`, color: p.subtext }] : []),
      ]),
    )
  } else if (list.length > 0 && done < list.length) {
    const current = list.find(t => t.status === 'in_progress')
    out.push(
      segment('todos', 95, [
        { text: '▸ ', color: p.blue },
        { text: tally, color: p.text, bold: true },
        { text: ` ${clipWidth(current?.active || current?.text || w.todos, 22)}`, color: p.subtext },
      ]),
    )
  }

  for (const [i, c] of (s?.counts ?? []).entries()) {
    const base = c.kind === 'checklist' ? 90 : c.kind === 'counter' ? 70 : 60
    out.push(segment(`count-${i}`, base - i, countParts(c, p, 14)))
  }

  if (s && s.phases.length > 0) {
    const dots = s.phases.map((ph, i) => ({
      text: i === s.current ? '◉' : ph.status === 'done' ? '●' : '○',
      color: i === s.current ? p.blue : ph.status === 'done' ? p.green : p.track,
    }))
    const now = s.phases[s.current]
    out.push(segment('roadmap', 80, [...dots, ...(now ? [{ text: ` ${phaseShort(now.name)}`, color: p.text }] : [])]))
  }

  if (showTeam && s?.team && s.team.length > 0) {
    const t = teamTally(s.team)
    out.push(
      segment('team', 50, [
        { text: `${w.team} ${s.team.length}`, color: p.text },
        ...(t.busy ? [{ text: ` ${w.busy}${t.busy}`, color: p.green }] : []),
        ...(t.approval ? [{ text: ` ${w.approval}${t.approval}`, color: p.orange }] : []),
        ...(t.stuck ? [{ text: ` ${w.stuck}${t.stuck}`, color: p.red, bold: true }] : []),
      ]),
    )
  }

  if (s && s.hasLocks && s.locks.length === 0) {
    out.push(segment('locks', 30, [{ text: `${w.lock} ${w.free}`, color: p.overlay }]))
  } else if (s && s.locks.length > 0) {
    const first = s.locks[0]!
    out.push(
      segment('locks', 40, [
        { text: `${w.lock} `, color: p.subtext },
        { text: clipWidth(first.actor, 12), color: p.orange },
        ...(s.locks.length > 1 ? [{ text: ` +${s.locks.length - 1}`, color: p.subtext }] : []),
      ]),
    )
  }

  return out
}

const STATE_ORDER: WpAgent['state'][] = ['stuck', 'approval', 'busy', 'idle', 'unknown']

// `codex-M` and `Codex M` name the same holder
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  return norm(a) !== '' && norm(a) === norm(b)
}

function ago(at: number, since: string | undefined): string {
  const t = since ? Date.parse(since) : NaN
  if (!Number.isFinite(t)) return ''
  const m = Math.max(0, Math.round((at - t) / 60_000))

  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

// Kept by the module, so a reload starts them over: who this session is, and its transcript file
let isRefreshing = false
let transcript: string | undefined
let homeDir = ''
let self: string | undefined
let lang = ''

async function refresh($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const s = await collect($, homeDir, self)
    await update($, snapshot, () => s)
    transcript ??= await transcriptPath($, homeDir)
    const g = await readGoal($, transcript)
    if (g !== undefined) await update($, goal, () => g)
  } finally {
    isRefreshing = false
  }
}

// The todo list as the transcript left it, so a reload or a resume keeps it
async function backfillTodos($: EngineInterface) {
  let list: WpTodo[] = []
  for (const m of await $.session.messages()) {
    for (const call of m.toolUses ?? []) list = replayTodo(list, String(call.tool), call.input, call.result)
  }
  await update($, todos, old => (old.length === 0 ? list : old))
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'waypoint',
      description: 'Project progress: open or close the detail pane; `refresh` to re-read now, `config` for the config file',
      argumentHint: '[refresh|config]',
    })
    homeDir = await home($)
    const pane = await $.env.get('OTTY_PANE_ID')
    self = pane ? normalizePane(pane) : undefined
    lang = (await $.env.get('LANG')) ?? ''
    void backfillTodos($).catch(() => undefined)
    void refresh($).catch(() => undefined)
    $.clock.every(cfg.refreshSeconds * 1000, () => void refresh($).catch(() => undefined))

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    void refresh($).catch(() => undefined)

    return ran
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await update($, todos, () => [])
    await update($, goal, () => null)

    return next(e)
  })

  on('tool.call', { tool: ['TodoWrite', 'TaskCreate', 'TaskUpdate'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      await update($, todos, list => replayTodo(list, String(e.tool), e as unknown as Record<string, unknown>, ran.result))
    }

    return ran
    // A failed list update never holds up the tool itself
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'waypoint' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'refresh') {
      await refresh($)
      return { text: 'refreshed' }
    }
    if (arg === 'config') {
      const s = await read($, snapshot)
      return {
        text: [
          s?.configPath ? `waypoint reads ${s.configPath}` : 'waypoint found no config and shows what it detects.',
          'Put one in the project as .claude/waypoint.json, or list projects in ~/.claude/waypoint.json as { "projects": [ { "paths": [...], ... } ] }.',
          'See the README for every field: checklists, roadmap, counters, beads, github, team, locks, panes.',
        ].join('\n'),
      }
    }
    if (arg) return { text: 'Usage: /waypoint [refresh|config]' }
    const open = (await $.ui.panes()).some(p => p.id === PANE)
    if (open) {
      await $.ui.close({ id: PANE })
      return { text: 'pane closed' }
    }
    await $.ui.open({ id: PANE, title: 'Waypoint', rows: 36 })
    void refresh($).catch(() => undefined)

    return { text: 'pane opened' }
  })

  // One row above the prompt: capsules for the goal, each count, the roadmap, the team and the locks
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await read($, snapshot)
    if (s && !s.isShown) return next(e)
    const g = await read($, goal)
    const list = await read($, todos)
    const p = await palette($)
    const w = WORDS[language(cfg, s, g, list, lang)]
    const all = bandSegments(s, g, list, p, w, cfg.showTeam)
    if (all.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const isCapsule = cfg.style === 'capsule'
    const kept = fitSegments(all, columns, isCapsule ? 1 : 3)

    return (
      <Box>
        <Text wrap="truncate-end">
          {kept.map((seg, i) => (
            <Text>
              {i > 0 && <Text color={p.track}>{isCapsule ? ' ' : ' · '}</Text>}
              <Text backgroundColor={isCapsule ? p.fill : undefined}>
                {isCapsule ? ' ' : ''}
                {seg.parts.map(part => (
                  <Text color={part.color} bold={part.bold}>
                    {part.text}
                  </Text>
                ))}
                {isCapsule ? ' ' : ''}
              </Text>
            </Text>
          ))}
        </Text>
      </Box>
    )
  })

  // The detail pane: everything the band abbreviates
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const g = await read($, goal)
    const list = await read($, todos)
    const p = await palette($)
    const w = WORDS[language(cfg, s, g, list, lang)]
    const width = Math.max(20, (e.props.bodyColumns ?? e.viewport?.columns ?? 60) - 2)
    const title = (text: string) => (
      <Text color={p.subtext} bold>
        {text}
      </Text>
    )
    const stateColor: Record<WpAgent['state'], string> = {
      busy: p.green,
      idle: p.overlay,
      approval: p.orange,
      stuck: p.red,
      unknown: p.overlay,
    }

    const done = list.filter(t => t.status === 'completed').length
    const goalBlock =
      g || list.length > 0 ? (
        <Box flexDirection="column">
          {title(w.goal)}
          {g && (
            <Text>
              <Text color={g.isMet ? p.green : p.indigo}>{g.isMet ? '✓ ' : '◎ '}</Text>
              <Text color={p.text} bold>
                {g.condition}
              </Text>
            </Text>
          )}
          {g?.reason && !g.isMet && <Text color={p.overlay}>{g.reason}</Text>}
          {list.length > 0 && (
            <Text color={p.subtext}>
              {w.todos} {done}/{list.length}
            </Text>
          )}
          {list.slice(0, 12).map(t => (
            <Text wrap="truncate-end">
              <Text color={t.status === 'completed' ? p.green : t.status === 'in_progress' ? p.blue : p.track}>
                {t.status === 'completed' ? '  ✓ ' : t.status === 'in_progress' ? '  ▸ ' : '  ○ '}
              </Text>
              <Text color={t.status === 'completed' ? p.overlay : p.text}>{t.status === 'in_progress' ? t.active || t.text : t.text}</Text>
            </Text>
          ))}
        </Box>
      ) : null

    const countBlock =
      s && s.counts.length > 0 ? (
        <Box flexDirection="column">
          {title(w.checklists)}
          {s.counts.map(c => (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                {countParts(c, p, Math.min(40, width - 16), true).map(part => (
                  <Text color={part.color} bold={part.bold}>
                    {part.text}
                  </Text>
                ))}
                {c.detail && <Text color={p.overlay}> {clipWidth(c.detail, Math.max(10, width - 30))}</Text>}
              </Text>
              {(c.items ?? [])
                .filter(it => !it.isDone)
                .slice(0, 8)
                .map(it => (
                  <Text wrap="truncate-end">
                    <Text color={p.track}>{'  ○ '}</Text>
                    <Text color={p.text}>{clipWidth(it.text, width - 4)}</Text>
                  </Text>
                ))}
            </Box>
          ))}
        </Box>
      ) : null

    const roadBlock =
      s && s.phases.length > 0 ? (
        <Box flexDirection="column">
          {title(w.roadmap)}
          {s.phases.map((ph, i) => (
            <Text wrap="truncate-end">
              <Text color={i === s.current ? p.blue : ph.status === 'done' ? p.green : p.track}>
                {i === s.current ? '◉ ' : ph.status === 'done' ? '● ' : '○ '}
              </Text>
              <Text color={ph.status === 'done' ? p.subtext : p.text} bold={i === s.current}>
                {ph.name}
              </Text>
            </Text>
          ))}
        </Box>
      ) : null

    const teamBlock =
      cfg.showTeam && s?.team && s.team.length > 0 ? (
        <Box flexDirection="column">
          {title(`${w.team} ${s.team.length}`)}
          {[...s.team]
            .sort((x, y) => STATE_ORDER.indexOf(x.state) - STATE_ORDER.indexOf(y.state))
            .map(a => {
              const held = s.locks.find(l => sameName(l.actor, a.name))
              const where = a.name.toLowerCase().includes(a.agent.toLowerCase()) ? '' : `${a.agent} · `
              return (
                <Text wrap="truncate-end">
                  <Text color={stateColor[a.state]}>● </Text>
                  <Text color={p.text}>{a.name}</Text>
                  <Text color={stateColor[a.state]}> {w[a.state]}</Text>
                  {held && <Text color={p.orange}> {w.lock}{held.task ? ` ${held.task}` : ''}</Text>}
                  <Text color={p.overlay}>
                    {' '}
                    {where}
                    {a.cwd.split('/').pop()}
                  </Text>
                </Text>
              )
            })}
        </Box>
      ) : null

    const lockBlock =
      s && s.locks.length > 0 ? (
        <Box flexDirection="column">
          {title(w.locks)}
          {s.locks.map(l => (
            <Text wrap="truncate-end">
              <Text color={p.orange}>● </Text>
              <Text color={p.text}>{l.actor}</Text>
              {l.task && <Text color={p.subtext}> {l.task}</Text>}
              {l.since && <Text color={p.overlay}> {ago(s.at, l.since)}</Text>}
              <Text color={p.overlay}> {l.label}</Text>
            </Text>
          ))}
        </Box>
      ) : null

    const notes = [...(s && !s.configPath ? [w.noConfig] : []), ...(s?.problems ?? [])]
    const blocks = [goalBlock, countBlock, teamBlock, lockBlock, roadBlock].filter(b => b !== null)

    return (
      <Box flexDirection="column" rowGap={1}>
        {s && (
          <Text>
            <Text color={p.text} bold>
              {s.project}
            </Text>
          </Text>
        )}
        {blocks.length === 0 && <Text color={p.subtext}>{w.nothing}</Text>}
        {blocks}
        {notes.length > 0 && (
          <Box flexDirection="column">
            {notes.map(n => (
              <Text color={p.overlay} wrap="truncate-end">
                {n}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
