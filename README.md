English | [简体中文](README.zh-CN.md)

# waypoint

Where your project stands, in one row above the Claude Code prompt. Written as a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview).

```
 ◎ Ship the beta 3/7   Sprint 12 ▰▰▰▱▱ 6/10   Screens 12/30   ●●◉○ Beta   agents 4 busy2 stuck1   lock codex-A
❯ █
```

Every item is a soft capsule in Apple system colours, light or dark with your Claude Code theme. When the row is short, the least important capsules give way first. `/waypoint` opens a pane with the details: open checklist items, every phase, each agent and what it holds.

> **Requires Claude Code 2.1.289 or newer.** Mods are an early-access API that may change between releases. If waypoint stops drawing after an update, please open an issue.

## Install

In Claude Code:

```
/plugin marketplace add VibeMage/claude-mod-waypoint
/plugin install waypoint@claude-mod-waypoint
```

The row appears right away. It works with no setup: it shows your `/goal`, Claude's todo list, the first `TODO.md` that has checkboxes and the phase table in `ROADMAP.md`. Add a config file to follow exactly what you care about.

## What it can show

| Capsule | What it is | Source |
| --- | --- | --- |
| ◎ Goal | The session's `/goal`, ✓ once Claude Code's evaluator finds it met, with the todo tally beside it | the session transcript (`goal_status`, `/goal`) |
| ▸ Todos | Without a goal: done/total and the item in progress | TodoWrite and the Task tools |
| Checklist | `- [x]` / `- [ ]` items of one section of a Markdown file, with a bar | any `.md` file |
| Counter | A tally you keep by hand, or one a command prints as `done/total` | config |
| ●◉○ Roadmap | One dot per phase: done, current, ahead | a Markdown table with a phase and a status column |
| Epic | A beads epic's closed/total children | `bd epic status --json`, at most every 5 minutes |
| Milestone | A GitHub milestone's closed/total issues | `gh api`, at most every 5 minutes, only when configured |
| Agents | The Claude Code and Codex panes working on the same project: busy, waiting for approval, stuck (rate limit, model at capacity) | [Otty](https://otty.sh) panes whose folder is the project or one of its git worktrees |
| Lock | Who holds a lock file, and on which task | config |

## Config

waypoint reads, in order:

1. `.claude/waypoint.json` in the project, a single project object;
2. `~/.claude/waypoint.json`, as `{ "projects": [ { "paths": ["~/code/app"], ... } ] }`, for projects whose repository you would rather not touch.

```json
{
  "name": "My App",
  "checklists": [{ "file": "docs/TODO.md", "marker": "current sprint" }],
  "roadmap": { "file": "docs/ROADMAP.md", "current": "Beta" },
  "counters": [{ "label": "Screens", "done": 12, "total": 30 }],
  "beads": { "epic": "app-12" },
  "github": { "milestone": "v1.0" },
  "team": { "panes": { "p_1a2b3c_4": "Codex A" } },
  "locks": [{ "path": ".local/deploy.lock", "label": "deploy", "worktrees": true }],
  "panes": ["p_1a2b3c_3"]
}
```

| Field | Meaning |
| --- | --- |
| `name` | The project's name in the pane |
| `root` | The folder relative paths resolve against (default: the repository root) |
| `paths` | Global file only: the folders this entry applies to |
| `panes` | Draw the row only in these Otty panes (`p_…` ids); the pane still opens anywhere |
| `checklists[]` | `file`, then which section: `section` (a heading that contains this text), or `marker` (the **last** heading that contains it, for files where each new batch is appended), else the first section with open items. `label` overrides the name taken from the heading. Only items at the left margin count; indented ones are sub-steps |
| `roadmap` | `file` and optionally `current` (the phase name it starts with), or `false` |
| `counters[]` | `label` with `done` and `total`, or `command` (an argv array run in the root; its output must contain `done/total`) |
| `beads` | `true`, `false` or `{ "epic": "<id>" }`. On by default when the root has `.beads/` |
| `github` | `true` or `{ "milestone": "<title>" }`. Off by default |
| `team` | `false`, or `{ "panes": { "<pane id>": "<name>" } }` to name exactly which panes, or `{ "cwds": [...], "agents": ["Codex"], "stuck": ["text that means stuck"] }` to widen or narrow the automatic match |
| `locks[]` | `path` (a file, or a directory holding `owner.json`), `label`, and `worktrees: true` to look for it in every git worktree. The holder is read from `actor`, `owner`, `holder` or `user`, the task from `task` or `issue` |

Settings (`/config` › waypoint): language (`auto`, `en`, `zh`), style (`capsule` or `plain`), refresh interval (20 s by default), and whether to show agents.

## Commands

- `/waypoint`: open or close the detail pane
- `/waypoint refresh`: re-read everything now
- `/waypoint config`: which config file is in use

## What waypoint runs and reads

waypoint is a TypeScript module that Claude Code runs in its mod sandbox. It has no dependencies, downloads nothing and writes no files.

- **Reads** the Markdown files and lock files your config names (or `TODO.md` / `ROADMAP.md` when there is none), its config files, the session's transcript (only the `/goal` records and todo tool calls), and your Claude Code `theme` setting.
- **Runs**, every refresh: `git worktree list`, `grep` over the session transcript for `/goal` records, and with Otty, `otty pane list` and `otty pane capture --lines 12` on the agent panes it shows, to tell busy, stuck and waiting apart. Every 5 minutes at most: `bd epic status` when beads is on, `gh api` for milestones when GitHub is configured (the one network request, made by your own `gh`). Plus any `command` you configure for a counter.
- **Never** types into another pane, changes a tracker, or edits a file.

See [PRIVACY.md](PRIVACY.md).

## Develop

```sh
claude --plugin-dir .          # load it for one session; saving a file reloads it
claude plugin validate .
claude plugin test .
```

## License

MIT
