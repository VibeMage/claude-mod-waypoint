# Privacy

waypoint collects nothing, stores nothing beyond the running session, and sends nothing to its author.

- **What it reads.** On your machine only: the Markdown, lock and config files named in its config (or `TODO.md` and `ROADMAP.md`); the `/goal` records and todo tool calls in the session's transcript; your Claude Code `theme` setting; with Otty, the list of panes and the last 12 lines on the screen of each agent pane it shows, to tell busy, stuck and waiting apart.
- **What it keeps.** The figures it draws live in the session's mod state while Claude Code runs. waypoint writes no files and keeps nothing across sessions.
- **What it sends.** Nothing of its own. When you configure a GitHub milestone, your own `gh` CLI asks the GitHub API for your repository's milestones; when beads is on, your own `bd` reads its database. waypoint has no server and its author receives no data.
- **Personal data.** Checklist items, goals and pane screens can contain personal data. waypoint reads them only to draw a short label on your own screen, and does not keep or transmit them.

Questions: open an issue at https://github.com/VibeMage/claude-mod-waypoint/issues.
