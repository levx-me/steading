"""Run by bin/sidebar (Claude Code hook: PostToolUse on any tool, and Stop), in the
background with the hook's event on stdin: the agent's repository and
context use, as herdr pane tokens for its sidebar, with or without a deck open.

  $repo    the branch, commits not pushed (↑) or not pulled (↓), files not committed
  $model   the model
  $ctx     context used: a bar and a percentage, below 80%
  $ctxhot  the same from 80% on, so a ui.sidebar.agents.rows layout can colour it
  $tasks   its task list: a bar and done/total, from ~/.claude/tasks/session-<id>

It also names the pane and its tab after the session's title, when that changes. While
subagents work, bin/crew spins $crew ("⠋ N") on the pane and its workspace.

Tool calls report at most every 3 seconds; the end of a turn always reports."""
import json
import os
import subprocess
import sys
import time

# Nerd Font icon before each token's value (JetBrainsMono Nerd Font); change them here.
# STEADING_SIDEBAR_ICONS=0 turns them off.
ICONS = {"repo": "\ue725", "model": "\U000f06a9", "ctx": "\U000f035b", "ctxhot": "\U000f035b", "tasks": "\uf4a0"}
if os.environ.get("STEADING_SIDEBAR_ICONS") == "0":
    ICONS = {}
# Tree guides ("├ ", "└ " on the last row shown) before the first token of each row of the
# agent's lines, as the layout in ~/.config/herdr/config.toml sets them. STEADING_SIDEBAR_TREE=0 off.
ROWS = [("repo",), ("model", "ctx", "ctxhot"), ("tasks",)]
TREE = os.environ.get("STEADING_SIDEBAR_TREE") != "0"

event = json.loads(sys.stdin.read() or "{}")
pane = os.environ.get("HERDR_PANE_ID", "")
if os.environ.get("HERDR_ENV") != "1" or not pane:
    sys.exit(0)  # outside herdr
state = os.path.join(os.environ.get("TMPDIR", "/tmp"), "steading", pane.replace(":", "_").replace("/", "_"))
herdr = os.environ.get("HERDR_BIN_PATH", "herdr")

# The main agent's turn, as Claude Code's own hooks see it: herdr reads Claude off the screen and
# calls it idle while a tool runs. A request or a tool call marks the turn; its end clears it.
lead_mark = os.path.join(state, "main-busy")
if not event.get("agent_id"):
    # A new process (startup, /restart's resume, /clear) has no turn running: a turn that /restart
    # cut off never reached its Stop hook, so its mark would keep the crew spinner going.
    if event.get("hook_event_name") in ("Stop", "SessionStart"):
        try:
            os.remove(lead_mark)
        except OSError:
            pass
    else:
        os.makedirs(state, exist_ok=True)
        open(lead_mark, "w").close()
        if event.get("hook_event_name") == "UserPromptSubmit":
            subprocess.Popen([sys.executable, "-I", os.path.join(os.path.dirname(os.path.abspath(__file__)), "crew"), pane,
                              event.get("transcript_path", "")[:-len(".jsonl")] + "/subagents"],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
            sys.exit(0)


def spin():
    """bin/crew spins $crew while agents work here and exits once none does (one per pane)."""
    folder = event.get("transcript_path", "")[:-len(".jsonl")] + "/subagents"
    subprocess.Popen([sys.executable, "-I", os.path.join(os.path.dirname(os.path.abspath(__file__)), "crew"), pane, folder],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


if event.get("agent_id"):
    # A subagent at work. herdr reads Claude's state off the screen, so a session whose main turn
    # has ended reads idle while its subagents still work, and it takes no state reports for
    # Claude. Show the crew instead: a spinning $crew on the agent's row and its workspace's row,
    # for as long as subagents keep working.
    crew_stamp = os.path.join(state, "crew")
    try:
        if time.time() - os.path.getmtime(crew_stamp) < 5:
            sys.exit(0)
    except OSError:
        pass
    os.makedirs(state, exist_ok=True)
    open(crew_stamp, "w").close()
    spin()
    sys.exit(0)

stamp = os.path.join(state, "sidebar")
try:
    if event.get("hook_event_name") != "Stop" and event.get("tool_name") not in ("TaskCreate", "TaskUpdate") and time.time() - os.path.getmtime(stamp) < 3:
        sys.exit(0)
except OSError:
    pass
os.makedirs(state, exist_ok=True)
open(stamp, "w").close()
if event.get("hook_event_name") != "Stop":
    spin()  # the main agent at work counts too

os.environ.setdefault("STEADING_BASE", state)
from importlib.machinery import SourceFileLoader  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script's folder out
from tasklist import task_folder  # noqa: E402

v = SourceFileLoader("viewer", os.path.join(os.path.dirname(os.path.abspath(__file__)), "viewer.py")).load_module()

# The repository: as the git tab's border shows it.
cwd = event.get("cwd") or os.getcwd()
repo = v.ANSI.sub("", v.repo_state(cwd)).strip()

# The context: the latest request's tokens, from the end of the transcript.
d = v.Digest()
try:
    with open(event.get("transcript_path", ""), "rb") as f:
        f.seek(max(0, os.path.getsize(f.name) - 400_000))
        for raw in f.read().splitlines()[1:]:  # the first line may be cut
            try:
                d.feed(json.loads(raw))
            except ValueError:
                pass
except OSError:
    pass
model = v.re.sub(r"-\d{8}$", "", (d.model or d.requested or "").replace("claude-", ""))
ctx = ""
if d.context:
    pct, _ = v.context_use(d)
    filled = min(5, round(pct / 20))
    ctx = f"{'▰' * filled}{'▱' * (5 - filled)} {pct}%"

# The task list (TaskCreate/TaskUpdate).
tasks = []
folder = task_folder(event.get("session_id", "")) if event.get("session_id") else ""
for name in (os.listdir(folder) if folder and os.path.isdir(folder) else []):
    if not name.endswith(".json"):
        continue
    try:
        with open(os.path.join(folder, name)) as f:
            tasks.append(json.load(f).get("status"))
    except (OSError, ValueError):
        pass
tasks = [t for t in tasks if t in ("pending", "in_progress", "completed")]
done = tasks.count("completed")
bar = ""
if tasks:
    filled = round(5 * done / len(tasks))
    bar = f"{'▰' * filled}{'▱' * (5 - filled)} {done}/{len(tasks)}"

args = [os.environ.get("HERDR_BIN_PATH", "herdr"), "pane", "report-metadata", pane, "--source", "steading"]
hot = ctx and v.context_use(d)[0] >= 80
values = {"repo": repo, "model": model, "ctx": "" if hot else ctx, "ctxhot": ctx if hot else "", "tasks": bar}
shown = [r for r in ROWS if any(values[n] for n in r)]
for row in shown:
    first = True
    for name in row:
        if values[name]:
            values[name] = ICONS.get(name, "") and ICONS[name] + " " + values[name] or values[name]
            if TREE and first:
                values[name] = ("└ " if row is shown[-1] else "├ ") + values[name]
            first = False
for name, value in values.items():
    args += ["--token", f"{name}={value}"] if value else ["--clear-token", name]
try:
    subprocess.run(args, capture_output=True, timeout=5)
except (OSError, subprocess.TimeoutExpired):
    pass

# The pane's name: the session's title (one set with /rename, else Claude's own, which changes
# only when the talk turns to something else), so the pane and its tab read as the conversation
# rather than the command that started it. Renamed only when the title changes.
named = os.path.join(state, "title")
try:
    with open(named) as f:
        before = f.read()
except OSError:
    before = ""
if d.title and d.title != before:
    try:
        subprocess.run([herdr, "pane", "rename", pane, d.title], capture_output=True, timeout=5)
        out = subprocess.run([herdr, "pane", "get", pane], capture_output=True, text=True, timeout=5).stdout
        tab = json.loads(out)["result"]["pane"]["tab_id"]  # the tab keeps a name of its own
        subprocess.run([herdr, "tab", "rename", tab, d.title], capture_output=True, timeout=5)
        with open(named, "w") as f:
            f.write(d.title)
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError):
        pass
