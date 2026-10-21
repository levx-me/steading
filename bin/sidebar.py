"""Run by bin/sidebar (Claude Code hook: PostToolUse on any tool, and Stop), in the
background with the hook's event on stdin: the agent's repository and
context use, as herdr pane tokens for its sidebar, with or without a deck open.

  $repo    the branch, commits not pushed (↑) or not pulled (↓), files not committed
  $model   the model
  $ctx     context used: a bar and a percentage, below 80%
  $ctxhot  the same from 80% on, so a ui.sidebar.agents.rows layout can colour it
  $tasks   its task list: a bar and done/total, from ~/.claude/tasks/session-<id>

It also names the pane and its tab after the session's title, when that changes. While
subagents work it sets $crew ("⠿ N") on the pane and its workspace, lapsing 90 s after the last one.

Tool calls report at most every 3 seconds; the end of a turn always reports."""
import json
import os
import subprocess
import sys
import time

event = json.loads(sys.stdin.read() or "{}")
pane = os.environ.get("HERDR_PANE_ID", "")
if os.environ.get("HERDR_ENV") != "1" or not pane:
    sys.exit(0)  # outside herdr
state = os.path.join(os.environ.get("TMPDIR", "/tmp"), "steading", pane.replace(":", "_").replace("/", "_"))
herdr = os.environ.get("HERDR_BIN_PATH", "herdr")

if event.get("agent_id"):
    # A subagent at work. herdr reads Claude's state off the screen, so a session whose main turn
    # has ended reads idle while its subagents still work, and it takes no state reports for
    # Claude. Show the crew instead: $crew on the agent's row and its workspace's row, for as
    # long as subagents keep working (the tokens lapse 90 s after the last tool call).
    crew_stamp = os.path.join(state, "crew")
    try:
        if time.time() - os.path.getmtime(crew_stamp) < 5:
            sys.exit(0)
    except OSError:
        pass
    os.makedirs(state, exist_ok=True)
    open(crew_stamp, "w").close()
    folder = event.get("transcript_path", "")[:-len(".jsonl")] + "/subagents"
    try:
        busy = sum(1 for f in os.listdir(folder)
                   if f.endswith(".jsonl") and time.time() - os.path.getmtime(os.path.join(folder, f)) < 90)
    except OSError:
        busy = 1
    value, ttl = f"⠿ {max(busy, 1)}", "90000"
    try:
        subprocess.run([herdr, "pane", "report-metadata", pane, "--source", "steading-crew",
                        "--token", f"crew={value}", "--ttl-ms", ttl], capture_output=True, timeout=5)
        out = subprocess.run([herdr, "pane", "get", pane], capture_output=True, text=True, timeout=5).stdout
        space = json.loads(out)["result"]["pane"]["workspace_id"]
        subprocess.run([herdr, "workspace", "report-metadata", space, "--source", f"steading-crew-{pane}",
                        "--token", f"crew={value}", "--ttl-ms", ttl], capture_output=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError):
        pass
    sys.exit(0)

stamp = os.path.join(state, "sidebar")
try:
    if event.get("hook_event_name") != "Stop" and event.get("tool_name") not in ("TaskCreate", "TaskUpdate") and time.time() - os.path.getmtime(stamp) < 3:
        sys.exit(0)
except OSError:
    pass
os.makedirs(state, exist_ok=True)
open(stamp, "w").close()

os.environ.setdefault("STEADING_BASE", state)
from importlib.machinery import SourceFileLoader  # noqa: E402

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

def task_folder(session):
    """Where Claude Code keeps this session's task list (one JSON file per task):
    ~/.claude/tasks/<team>. With agent teams on, the team is named after the process,
    not the conversation, so a resumed conversation's list is under the team made when
    its process started: found from the process's record (~/.claude/sessions/<pid>.json,
    its start and cwd) and the team's (~/.claude/teams/<team>/config.json, made then)."""
    home = os.path.expanduser("~/.claude")
    own = os.path.join(home, "tasks", f"session-{session[:8]}")
    started = cwd = None
    for name in os.listdir(os.path.join(home, "sessions")) if os.path.isdir(os.path.join(home, "sessions")) else []:
        if name.endswith(".json"):
            try:
                with open(os.path.join(home, "sessions", name)) as f:
                    rec = json.load(f)
            except (OSError, ValueError):
                continue
            if rec.get("sessionId") == session and (started is None or rec.get("startedAt", 0) > started):
                started, cwd = rec.get("startedAt", 0), rec.get("cwd")
    best = None
    if started:
        for team in os.listdir(os.path.join(home, "teams")) if os.path.isdir(os.path.join(home, "teams")) else []:
            try:
                with open(os.path.join(home, "teams", team, "config.json")) as f:
                    conf = json.load(f)
            except (OSError, ValueError):
                continue
            gap = abs(conf.get("createdAt", 0) - started)
            lead = next((m for m in conf.get("members", []) if m.get("name") == "team-lead"), {})
            if gap < 15_000 and lead.get("cwd") in (cwd, None) and (best is None or gap < best[0]):
                best = (gap, os.path.join(home, "tasks", team))
    return best[1] if best and os.path.isdir(best[1]) else own


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
for name, value in (("repo", repo), ("model", model), ("ctx", "" if hot else ctx), ("ctxhot", ctx if hot else ""), ("tasks", bar)):
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
