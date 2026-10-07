// Pure parsers and layout helpers: no `$`, so the tests run them directly

import type { WpAgentState, WpGoal, WpPhase, WpTodo } from '../types'

export type Heading = { level: number; text: string; line: number }

export type Section = { heading: string; label: string; done: number; total: number; items: { text: string; isDone: boolean }[] }

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
// A checkbox at the left margin; indented ones are sub-steps of the item above
const CHECKBOX = /^[-*+] \[( |x|X)\]\s+(.*)$/

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
}

// `一·三、第三批（2026-10-07 起，goal 范围）` → `第三批`; `2. Beta (in progress)` → `Beta`
export function sectionLabel(heading: string): string {
  const plain = stripMarkdown(heading)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/^[\d一二三四五六七八九十百·.、:：\s-]+(?=\S)/, '')
    .trim()

  return plain || stripMarkdown(heading)
}

export function headings(markdown: string): Heading[] {
  const out: Heading[] = []
  let isFenced = false
  markdown.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) isFenced = !isFenced
    if (isFenced) return
    const m = line.match(HEADING)
    if (m) out.push({ level: m[1]!.length, text: m[2]!, line: i })
  })

  return out
}

// Every heading's own checklist: the top-level checkboxes between it and the next heading, so a title that
// encloses the whole file never swallows its batches
export function sections(markdown: string): Section[] {
  const lines = markdown.split('\n')
  const hs = headings(markdown)
  const out: Section[] = []
  hs.forEach((head, i) => {
    const end = hs[i + 1]?.line ?? lines.length
    const items: Section['items'] = []
    let isFenced = false
    for (const line of lines.slice(head.line + 1, end)) {
      if (/^\s*(```|~~~)/.test(line)) isFenced = !isFenced
      if (isFenced) continue
      const m = line.match(CHECKBOX)
      if (m) items.push({ text: stripMarkdown(m[2]!), isDone: m[1] !== ' ' })
    }
    out.push({
      heading: stripMarkdown(head.text),
      label: sectionLabel(head.text),
      done: items.filter(it => it.isDone).length,
      total: items.length,
      items,
    })
  })

  return out
}

// The whole file's top-level checkboxes, for a list with no headings
export function wholeFile(markdown: string, label: string): Section {
  const items = markdown
    .split('\n')
    .map(line => line.match(CHECKBOX))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(m => ({ text: stripMarkdown(m[2]!), isDone: m[1] !== ' ' }))

  return { heading: label, label, done: items.filter(it => it.isDone).length, total: items.length, items }
}

export type SectionRule = { section?: string; marker?: string }

/**
 * Picks the checklist to follow: a heading containing `section`; else the LAST heading containing `marker`
 * (a batch file where each new batch is appended and marked); else the first heading whose own items are not
 * all done; else the whole file.
 */
export function pickSection(markdown: string, rule: SectionRule, fallbackLabel: string): Section | null {
  const all = sections(markdown).filter(s => s.total > 0)
  if (rule.section) return all.find(s => s.heading.includes(rule.section!)) ?? null
  if (rule.marker) {
    const marked = all.filter(s => s.heading.includes(rule.marker!))
    if (marked.length > 0) return marked[marked.length - 1]!
  }
  const open = all.find(s => s.done < s.total)
  if (open) return open
  const whole = wholeFile(markdown, fallbackLabel)

  return whole.total > 0 ? whole : null
}

const PHASE_HEAD = /阶段|里程碑|版本|phase|stage|milestone|version|release/i
const STATUS_HEAD = /状态|进度|status|state|progress/i

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => stripMarkdown(c))
}

export function phaseStatus(status: string): WpPhase['status'] {
  const s = status.trim()
  if (/未开始|not started|planned|^todo$|^[—–-]?$/i.test(s)) return 'todo'
  if (/未完成|incomplete/i.test(s)) return 'active'
  if (/完成|已发布|已上线|done|complete|shipped|released|✅|✓|✔/i.test(s)) return 'done'
  if (/进行|研究|开发中|in progress|doing|wip|active|current|ongoing|underway|🚧/i.test(s)) return 'active'

  return 'todo'
}

// The first Markdown table with a phase column and a status column, one phase per row
export function roadmapPhases(markdown: string): WpPhase[] {
  const lines = markdown.split('\n')
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = lines[i]!
    if (!head.trim().startsWith('|') || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) continue
    const names = cells(head)
    const phaseCol = names.findIndex(n => PHASE_HEAD.test(n))
    const statusCol = names.findIndex(n => STATUS_HEAD.test(n))
    if (phaseCol < 0 || statusCol < 0) continue
    const phases: WpPhase[] = []
    for (const row of lines.slice(i + 2)) {
      if (!row.trim().startsWith('|')) break
      const c = cells(row)
      const name = c[phaseCol] ?? ''
      if (!name) continue
      phases.push({ name, status: phaseStatus(c[statusCol] ?? '') })
    }
    if (phases.length > 0) return phases
  }

  return []
}

// The phase named by `current` (a prefix of its name), else the first under way, else the first not done
export function currentPhase(phases: WpPhase[], current?: string): number {
  if (current) {
    const named = phases.findIndex(p => p.name.startsWith(current) || p.name.includes(current))
    if (named >= 0) return named
  }
  const active = phases.findIndex(p => p.status === 'active')
  if (active >= 0) return active

  return phases.findIndex(p => p.status !== 'done')
}

// `0.2 自有化与品牌` → `0.2`; a phase with no version-like lead keeps its first word
export function phaseShort(name: string): string {
  const version = name.match(/^v?\d+(?:\.\d+)*/i)
  if (version) return version[0]
  const word = name.split(/[\s：:（(]/)[0] ?? name

  return word.length > 12 ? `${word.slice(0, 11)}…` : word
}

// Columns a string takes in a terminal: East Asian wide and emoji count two
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x300 && c <= 0x36f)) continue
    const isWide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0x303e) ||
      (c >= 0x3041 && c <= 0x33ff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xa000 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd)
    width += isWide ? 2 : 1
  }

  return width
}

// Cuts to `max` columns, an ellipsis in the last one
export function clipWidth(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (displayWidth(line) <= max) return line
  let out = ''
  for (const ch of line) {
    if (displayWidth(out + ch) > max - 1) break
    out += ch
  }

  return `${out}…`
}

export type Fit = { key: string; width: number; priority: number }

/**
 * Keeps the segments that fit in `columns`, `gap` columns between each, dropping the lowest priority first
 * (a higher number is dropped later); the order of what stays is the order given.
 */
export function fitSegments<T extends Fit>(segments: T[], columns: number, gap: number): T[] {
  const kept = [...segments]
  const total = () => kept.reduce((sum, s) => sum + s.width, 0) + Math.max(0, kept.length - 1) * gap
  while (kept.length > 1 && total() > columns) {
    let lowest = 0
    kept.forEach((s, i) => {
      if (s.priority < kept[lowest]!.priority) lowest = i
    })
    kept.splice(lowest, 1)
  }

  return kept
}

// A five-cell bar: ▰ per fifth done
export function bar(done: number, total: number, cells = 5): { filled: string; empty: string } {
  const n = total > 0 ? Math.min(cells, Math.round((done / total) * cells)) : 0

  return { filled: '▰'.repeat(n), empty: '▱'.repeat(cells - n) }
}

// The goal a /goal command or ProposeGoal set, from the transcript's text; `null` once cleared
export function goalFromText(text: string): string | null | undefined {
  const command = text.match(/<command-name>\/goal<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/)
  if (command) {
    const args = command[1]!.trim()
    if (args === '' || /^clear$/i.test(args)) return null
    return args
  }
  const hook = text.match(/Stop hook is now active with condition: "([\s\S]*?)"\.\s/)
  if (hook) return hook[1]!

  return undefined
}

// Applies one TodoWrite, TaskCreate or TaskUpdate call to the todo list
export function replayTodo(list: WpTodo[], tool: string, input: Record<string, unknown>, result: unknown): WpTodo[] {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return input.todos.map((t: Record<string, unknown>, i: number) => ({
      id: String(i),
      text: str(t.content) ?? '',
      active: str(t.activeForm) ?? str(t.content) ?? '',
      status: (t.status as WpTodo['status']) ?? 'pending',
    }))
  }
  if (tool === 'TaskCreate') {
    const id = str((result as { task?: { id?: unknown } } | undefined)?.task?.id)
    const text = str(input.subject) ?? ''
    return id ? [...list, { id, text, active: str(input.activeForm) ?? text, status: 'pending' }] : list
  }
  if (tool === 'TaskUpdate') {
    const id = str(input.taskId)
    const status = str(input.status)
    if (status === 'deleted') return list.filter(t => t.id !== id)
    return list.map(t =>
      t.id === id
        ? {
            ...t,
            text: str(input.subject) ?? t.text,
            active: str(input.activeForm) ?? t.active,
            status: (status as WpTodo['status'] | undefined) ?? t.status,
          }
        : t,
    )
  }

  return list
}

export const STUCK_PATTERNS = ['at capacity', 'rate limit', 'usage limit', 'overloaded', 'quota exceeded', 'hit your limit']
// Claude Code's permission prompt and Codex's approval prompt
export const APPROVAL_PATTERNS = ['Do you want to proceed', 'Do you want to make this edit', 'Would you like to']

// An agent pane's state from Otty's own and the last lines on its screen
export function paneState(ottyState: string, screen: string, stuck: string[], approval: string[], agent = ''): WpAgentState {
  const tail = screen.toLowerCase()
  if (stuck.some(p => tail.includes(p.toLowerCase()))) return 'stuck'
  if (approval.some(p => tail.includes(p.toLowerCase()))) return 'approval'
  if (ottyState === 'processing') return 'busy'
  // Claude Code reports `awaiting` on a permission prompt; Codex reports it at its idle prompt too
  if (ottyState === 'awaiting' && agent === 'Claude Code') return 'approval'
  if (ottyState === 'idle' || ottyState === 'awaiting') return 'idle'

  return 'unknown'
}

// Whether `path` is `dir` or lies under it
export function isUnder(path: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, '')

  return path === d || path.startsWith(`${d}/`)
}

export function hasCjk(text: string): boolean {
  return /[㐀-鿿가-힣぀-ヿ]/.test(text)
}

export function normalizePane(id: string): string {
  return id.startsWith('p_') ? id : `p_${id}`
}

// The goal as the newest transcript line about it leaves it: a goal_status record, `/goal <condition>`, or a
// clear (null). Lines are the transcript's JSONL rows that mention a goal, oldest first
export function latestGoal(lines: string[]): WpGoal | null {
  // Newest first; a line that merely quotes these strings (a tool result) is passed over
  for (const line of [...lines].reverse()) {
    let row: {
      type?: string
      content?: unknown
      attachment?: { type?: string; condition?: string; met?: boolean; reason?: string }
      message?: { content?: unknown }
    }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.attachment?.type === 'goal_status' && row.attachment.condition) {
      return { condition: row.attachment.condition, isMet: row.attachment.met === true, reason: row.attachment.reason }
    }
    // The command as typed is a user row; `/goal clear` is kept as a local-command notice, its text at the top
    const raw = row.type === 'user' ? row.message?.content : row.type === 'system' ? row.content : undefined
    const content = typeof raw === 'string' ? raw : ''
    if (!content.trimStart().startsWith('<command-name>/goal</command-name>')) continue
    const goal = goalFromText(content)
    return goal ? { condition: goal, isMet: false } : null
  }

  return null
}
