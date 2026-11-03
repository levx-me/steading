# Keys and mouse

**English** · [한국어](keys.ko.md) · [← README](../README.md)

## Open, close, move

The deck opens on its own beside any agent herdr recognises (Claude Code, Codex, OpenCode, ...) as it
starts. For the rest, add a key to herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+d"
type = "plugin_action"
command = "steading.toggle"
```

- `prefix+d` opens the deck beside the focused pane, or closes it; on the deck itself it closes that deck.
- The deck opens to the right of the agent. `L` in the deck moves it on top instead (or back), and
  that agent's deck keeps opening there.
- A deck you closed stays closed: runs are still recorded, and show when you open it again.
- To stop decks opening when an agent starts, turn off **Open with agents** in the settings (`,`).

## Keys

Focus the deck (click it, or use herdr's pane navigation). The bottom row always shows the keys that
apply right now.

| Where | Keys | Action |
|---|---|---|
| anywhere | `[` `]` (and, outside a log, `tab` `shift+tab`), `1`–`8` | previous / next tab, jump to one |
| | `A` `J` `S` `B` `T` `I` `D` `Y` | jump to a tab by its underlined letter (git is `I`: `G` stays vim's bottom; system is `Y`; not inside a log, where `B` moves the cursor) |
| | `L` | move the deck to the other side of the agent |
| | `,` | settings: follow new runs to their tab, open a deck with each agent, the jobs threshold (5, 10 or 30s) |
| | `ctrl+c`, or a click on `✕` at the tabs' left end | close the deck (`q` only goes back from a log to the list, so a stray `q` closes nothing) |
| run list | `j` `k` (or `↓` `↑`), `gg` `G` | pick a run (newest on top), the newest, the oldest |
| | `enter` `l` | move into its output |
| output | `h` `j` `k` `l`, `w` `b` `e`, `W` `B` `E`, `0` `^` `$`, `{` `}` | move the cursor (herdr copy-mode keys); a line wider than the box unfolds onto the rows under it while the cursor is on it |
| | `gg` `G`, `ctrl+d` `ctrl+u` | top / bottom (`G` follows the live run again), half page |
| | `v` `V`, `y` | select by character / line, yank (the cursor line when nothing is selected) |
| | `/` `?`, `n` `N` | search forward / back, repeat |
| | `tab` `shift+tab` | move the cursor between the run's command lines and its log |
| | `h` `j` `k` `l` at an edge | cross between them as one text; `k` on the first line or `h` on the first character goes back to the list |
| | `esc`, `q` or backspace | cancel the selection, or back to the run list |
| servers | `o` | open the server in the browser |
| system | `j` `k` (or `↓` `↑`, the wheel, a click), `g` `G` | move the selected row (a row, as in btop: after a re-sort it holds whichever process lands there; only these keys scroll the list), the first, the last |
| | `enter` `l` (or a click) on a Claude session, `h` | unfold it: what runs under it, indented below, and the cursor follows the session through re-sorts, the scroll keeping it and its rows in view, until you fold it, move the cursor, or it ends; fold it (`enter` does nothing on other rows) |
| | `K`, then `y` | end the process selected when `K` was pressed (SIGTERM; on a Claude session, its claude only), even if a re-sort has moved another onto the row; if that pid has since ended or names another process, nothing is ended. Any other key keeps it; the outcome shows in the hint line |
| | `s`, `u` | sort by CPU or memory; all users' processes or only yours |
| | `o` (or a click on its button) | go to the herdr workspace named `system`, or make it: `btop`, and `macmon` beside it on a Mac |
| agents | `enter`, then `j` `k`, `enter`, `esc` or backspace | in an agent's detail: move between its buttons and tasks, press one; `esc` or backspace goes back to the list |
| | `enter` on a task, then `j` `k`, `ctrl+d` `ctrl+u`, `esc` or backspace | its story: when it was made and the request it came from, what Claude said as it started and finished it, and where Claude named it; `esc`, backspace or a click on `← task` goes back |
| | on "▾ N more": `enter`, then `j` `k`, `ctrl+d` `ctrl+u`, `ctrl+f` `ctrl+b`, `ctrl+e` `ctrl+y`, `g` `G`, `esc` or backspace | the activity card unfolds and scrolls on its own, with its own cursor (vim's keys; `enter` on a long call opens its output in jobs); `esc` or backspace folds it |

Arrow keys work as `h` `j` `k` `l` everywhere. Backspace (or `ctrl+h`) leaves whatever `enter` opened (a run's or a
server's output, an agent's detail, a task's story, the activity card) as `esc` does; in a list it does nothing. The run list and the run's box under it each take the
tab's colour on their border while the cursor is in them; while it is in the list, the run's command
and log are also drawn faint (an agent's detail is not).

## Mouse

- Click a tab, a run in the list, a log line or a server.
- The wheel scrolls the log; over the run list it moves through the runs.
- Drag over a log to select it: it is copied as in herdr, with a note above the selection.

Yanks and selections go to `pbcopy`, `wl-copy` or `xclip`, falling back to the terminal clipboard (OSC 52).
