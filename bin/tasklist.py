"""Where Claude Code keeps a session's task list, shared by the sidebar hook and the deck."""
import json
import os


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


def read_tasks(session):
    """The session's real task list: [(id, subject, status)] from its folder, oldest first.
    A missing or empty folder is an empty list."""
    folder = task_folder(session) if session else ""
    out = []
    for name in os.listdir(folder) if folder and os.path.isdir(folder) else []:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(folder, name)) as f:
                t = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(t, dict) and t.get("status") in ("pending", "in_progress", "completed"):
            out.append((str(t.get("id", name[:-5])), str(t.get("subject", "")), t["status"]))
    return sorted(out, key=lambda t: (len(t[0]), t[0]))
