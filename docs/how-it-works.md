# How it works

**English** · [한국어](how-it-works.ko.md) · [← README](../README.md)

```mermaid
flowchart LR
  A[Claude Code<br/>Bash tool] -- PreToolUse --> H[bin/hook]
  H -- test / build:<br/>rewrite to --> R[bin/run]
  H -- anything else --> J[bin/job]
  A -- PostToolUse(Failure) --> C[bin/record]
  R -- bin/ptyrun --> S[(TMPDIR/steading/&lt;agent&gt;/)]
  J --> S
  C --> S
  R & C -- bin/pane --follow --> V[bin/viewer.py<br/>the deck]
  V -- reads --> S
  V -- bin/servers --> L[lsof]
  V -- transcripts --> T[(~/.claude/projects)]
```

- `bin/classify` reads a command line by its shell tokens: what it runs (test, build, deploy, git
  write), the core command to show (`cd x; env -u A pnpm test | tail` → `pnpm test`), and whether it
  may run live. Both hooks use it.
- `bin/hook` decides what a Bash call is. Tests and builds are rewritten to `bin/run` (approved, see
  below); a dev server only brings an open deck to `servers`; anything else is filed as a job, and
  `bin/job` finds Claude Code's output file for it once it starts.
- `bin/run` runs the command on a pseudo-terminal (`bin/ptyrun`), writes the run to
  `$TMPDIR/steading/<agent pane>/<kind>/runs/<n>/`, and returns the plain output and exit code.
- `bin/record` files git commands, deploys, and tests and builds that were not routed, after Claude
  ran them, and the ending of jobs.
- `bin/open` adds the run-it-plainly note to a Claude Code session. When the session is resumed in a
  new pane (or `/tmp` was cleared) and its deck is empty, `bin/restore` refills it from the session
  transcript, through `bin/record`.
- `bin/pane` opens the deck once per agent and tells it which tab to show; with `--follow` (runs) it
  only switches a deck that is already open.
- `bin/deck` is the herdr side: `toggle` for the key, `auto` for herdr's `pane.agent_detected` event,
  `flip` for `L`.
- `bin/viewer.py` draws the deck from those run directories and reloads itself when edited.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `STEADING_SOURCE` | `levx-me/steading` | Where `bin/install-claude` adds the Claude Code marketplace from (a path or `owner/repo`) |
| `TMPDIR` | `/tmp` | Parent of the run history (`$TMPDIR/steading`) |

Commands run in the deck get `CI=1` (no watch modes) and `FORCE_COLOR=1`, `CLICOLOR_FORCE=1`,
`PY_COLORS=1`, `CARGO_TERM_COLOR=always`.

## herdr's sidebar

A hook (`bin/sidebar`, after each tool call and at the end of each turn) reports each
agent's repository and context use to herdr as pane tokens, with or without a deck open:

- `$repo`: the branch, commits not pushed (`↑`) or not pulled (`↓`).
- `$repostate`: files not committed (`3 changed`) or `clean`; its own token so it takes its own colour.
  In a folder outside any git repository `$repo` reads ` no git` (a folder icon) and `$repostate` is empty.
- `$model`: the model.
- `$ctx`: context used, a bar and a percentage; from 80% on it is `$ctxhot` instead, so
  the layout can colour it.
- `$tasks`: the agent's task list (TaskCreate/TaskUpdate), a bar and done/total.
- `$crew`: a spinner and a count (`⠋ 2`) while the main turn runs and for each subagent still running, nested ones (a PM's workers) included. Subagents are counted from the SubagentStart and SubagentStop hooks (a marker per `agent_id` in the pane's state dir, cleared on SessionStart, dropped after 3 h), so a long silent tool call keeps its agent counted.
- `$tree1`..`$tree3`: tree guides (`├`, and `└` on the last row shown; empty for a row that is empty) in
  a token of their own, so a layout can colour them apart from the text. `STEADING_SIDEBAR_TREE=0` turns them off.
- `$wstree`, `$wsrepo`: workspace tokens for the Spaces panel's second row (herdr's own `branch` cannot take
  a guide): `└` and `$repo`'s text, with `$wsrepostate` for `$repostate`'s. With several agents in one workspace the last report wins.
- `$wsrun`, `$wstree2`: the Spaces panel's third row, what runs in the workspace: the ports of its dev servers (as the deck's
  servers section finds them) and the long jobs still going, `▶ :3000 :5173 · ⏳ 1 job`; empty, so the row goes, when nothing runs. `$wstree`
  becomes `├` while it shows. `$wstree`, `$wsrun` and `$wstree2` go out together in one source with no lifetime (herdr drops a token
  whose latest report lapses, so separate lifetimes would leave the guide open). A server can stop with no hook to say so, so whenever something
  runs, `bin/sidebar.py` starts `bin/steading_run.py`, one per workspace: every 10 s it recomputes the row, and once nothing runs it clears
  `$wsrun` and `$wstree2`, sets `$wstree` to `└` and exits (as it does when the workspace is gone). It outlives sessions.

Show them in herdr's agents list with a row layout in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], [{ token = "$wstree", fg = "#ffffff" }, { token = "$wsrepo", dim = true }, { token = "$wsrepostate", dim = true }],
        [{ token = "$wstree2", fg = "#ffffff" }, { token = "$wsrun", fg = "#98c379" }]]

[ui.sidebar.agents]
rows = [
  ["state_icon", { token = "workspace", bold = true }, "tab"],
  [{ token = "$tree1", fg = "#ffffff" }, { token = "$repo", dim = true }, { token = "$repostate", dim = true }],
  [{ token = "$tree2", fg = "#ffffff" }, { token = "$model", dim = true }, { token = "$ctx", dim = true }, { token = "$ctxhot", fg = "#e06c75", bold = true }],
  [{ token = "$tree3", fg = "#ffffff" }, { token = "$tasks", dim = true }],
]
```

## Security notes

- Routed tests and builds are returned to Claude Code as **approved** (`permissionDecision: "allow"`),
  so they do not ask for permission. Your deny and ask rules still apply. `npm test` and
  `npm run build` run whatever `package.json` says: if you do not want those auto-approved, remove
  them from the patterns in `bin/hook`.
- Git commands, deploys and jobs are never rewritten or approved by Steading.
- Run logs stay in `$TMPDIR`; nothing leaves the machine.

## Development

```sh
git clone git@github.com:levx-me/steading.git && cd steading
claude plugin marketplace add "$PWD" && claude plugin install steading@steading
herdr plugin link "$PWD"
bun test
```

With the plugin installed from your checkout, `bun test` itself runs in the deck. When the deck's
look changes, regenerate the README preview: `python3 docs/demo.py > docs/demo.svg`.
