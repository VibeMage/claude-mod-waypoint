import { expect, test } from 'claude-code/testing'

import {
  clipWidth,
  currentPhase,
  displayWidth,
  fitSegments,
  goalFromText,
  paneState,
  phaseShort,
  pickSection,
  roadmapPhases,
  sectionLabel,
  APPROVAL_PATTERNS,
  STUCK_PATTERNS,
} from '../hooks/parse'
import { readConfig } from '../hooks/register'

const BATCHES = `# 1.0 待办

## 一、本批（goal 范围）

- [x] **登录页** done
- [x] 设置页 done

## 一·二、第二批（进行中）

- [x] 首页
- [x] 搜索
- [x] 收藏
- [x] 分享
- [ ] 离线模式
  - [ ] an indented sub-step is not counted
- [ ] 推送通知

## 一·三、第三批（2026-10-07 起，goal 范围）

- [ ] 支付
- [ ] 订单
- [ ] 退款
- [ ] 打磨

## 二、等你决定（不在 goal 内）

- [x] 选云服务
- [ ] 定价
`

test('a marker picks the last marked batch, not the first unfinished one', async () => {
  const marked = pickSection(BATCHES, { marker: 'goal 范围' }, 'TODO')
  expect(marked?.label).toBe('第三批')
  expect([marked?.done, marked?.total]).toEqual([0, 4])

  const first = pickSection(BATCHES, {}, 'TODO')
  expect(first?.label).toBe('第二批')
  expect([first?.done, first?.total]).toEqual([4, 6])

  const named = pickSection(BATCHES, { section: '等你决定' }, 'TODO')
  expect([named?.done, named?.total]).toEqual([1, 2])
})

test('a file with no headings counts every top-level checkbox', async () => {
  const s = pickSection('- [x] one\n- [ ] two\n* [X] three\n', {}, 'TODO')
  expect([s?.label, s?.done, s?.total]).toEqual(['TODO', 2, 3])
})

test('section labels drop the ordinal and the parenthesis', async () => {
  expect(sectionLabel('一·三、第三批（2026-10-07 起，goal 范围）')).toBe('第三批')
  expect(sectionLabel('2. Beta (in progress)')).toBe('Beta')
  expect(sectionLabel('Milestone A')).toBe('Milestone A')
})

const ROADMAP = `## 阶段

| 阶段 | 状态 | 内容 |
|---|---|---|
| **0.1 原型** | **完成**（2026-10-06） | ... |
| **0.2 内测版** | 待开始（研究中） | ... |
| **0.3 公测** | 设计阶段 | ... |
| **1.0 正式上线** | 未开始 | ... |
| 之后：内容扩展 | — | ... |
`

test('roadmap phases come from the table with a phase and a status column', async () => {
  const phases = roadmapPhases(ROADMAP)
  expect(phases.map(p => p.status)).toEqual(['done', 'active', 'todo', 'todo', 'todo'])
  expect(phases[0]?.name).toBe('0.1 原型')
  expect(currentPhase(phases)).toBe(1)
  expect(currentPhase(phases, '0.3')).toBe(2)
  expect(phaseShort('0.2 内测版')).toBe('0.2')
  expect(phaseShort('Beta launch')).toBe('Beta')

  const english = roadmapPhases('| Milestone | Status |\n|---|---|\n| Alpha | Done ✅ |\n| Beta | In progress |\n| GA | Planned |\n')
  expect(english.map(p => p.status)).toEqual(['done', 'active', 'todo'])
})

test('wide characters take two columns and clipping respects them', async () => {
  expect(displayWidth('第三批')).toBe(6)
  expect(displayWidth('M04 ▰▱')).toBe(6)
  expect(displayWidth(clipWidth('完成第三批全部四项任务并出包', 9))).toBeLessThanOrEqual(9)
  expect(clipWidth('short', 10)).toBe('short')
})

test('the fit drops the lowest priority until the row fits, keeping the order', async () => {
  const segs = [
    { key: 'goal', width: 30, priority: 100 },
    { key: 'team', width: 20, priority: 50 },
    { key: 'list', width: 20, priority: 90 },
    { key: 'lock', width: 10, priority: 40 },
  ]
  expect(fitSegments(segs, 200, 1).map(s => s.key)).toEqual(['goal', 'team', 'list', 'lock'])
  expect(fitSegments(segs, 60, 1).map(s => s.key)).toEqual(['goal', 'list'])
  expect(fitSegments(segs, 5, 1).map(s => s.key)).toEqual(['goal'])
})

test('a /goal command row gives its condition; clear and an empty one give none', async () => {
  const row = (args: string) =>
    `<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>${args}</command-args>`
  expect(goalFromText(row('ship the beta'))).toBe('ship the beta')
  expect(goalFromText(row('clear'))).toBeNull()
  expect(goalFromText(row(''))).toBeNull()
  expect(goalFromText('A session-scoped Stop hook is now active with condition: "tests pass". Briefly')).toBe('tests pass')
  expect(goalFromText('nothing here')).toBeUndefined()
})

test('a pane is stuck or waiting by its screen, else by its state', async () => {
  const state = (otty: string, screen: string) => paneState(otty, screen, STUCK_PATTERNS, APPROVAL_PATTERNS)
  expect(state('processing', '■ Selected model is at capacity. Please try again.')).toBe('stuck')
  expect(state('processing', 'Would you like to run the following command?')).toBe('approval')
  expect(state('processing', '• Working (12s)')).toBe('busy')
  expect(state('awaiting', '› Ask Codex to do anything')).toBe('idle')
  expect(state('idle', '')).toBe('idle')
  expect(paneState('awaiting', '', STUCK_PATTERNS, APPROVAL_PATTERNS, 'Claude Code')).toBe('approval')
})

test('options are held to their range', async () => {
  expect(readConfig({}).refreshSeconds).toBe(20)
  expect(readConfig({ refreshSeconds: 1 }).refreshSeconds).toBe(5)
  expect(readConfig({ language: 'xx' }).language).toBe('auto')
  expect(readConfig({ style: 'plain' }).style).toBe('plain')
})

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } } as const

test('the band shows the todo progress as one row on terminal and desktop', async ($, on) => {
  on('tool.call', () => ({ result: { ok: true } }) as never)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'write mod', status: 'completed', activeForm: 'Writing mod' },
      { content: 'test mod', status: 'in_progress', activeForm: 'Testing mod' },
      { content: 'ship mod', status: 'pending', activeForm: 'Shipping mod' },
    ],
  } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'waypoint', surface, component: BAND.component, props: BAND.props as never })
    expect(await ui.find({ type: 'Text', text: '1/3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / Testing mod/ })).toBeDefined()
    await ui.unmount()
  }
})
