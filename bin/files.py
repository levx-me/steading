"""Which files the session's agents touched, as Claude Code's own hooks say: bin/sidebar.py runs
record() on every event, and the deck reads states(). Each PostToolUse of Read (R), Edit, Write or
NotebookEdit (W) appends one line to <TMPDIR>/steading/sessions/<session_id>.files:

  <ns> <agent_id or -> <agent_type or main, spaces as _> <R|W> <path>

A file's state is its latest line's agent and time, and W once any line wrote it (a later read does not
unwrite it)."""
import json
import os
import sys
import time

MODES = {"Read": "R", "Edit": "W", "Write": "W", "NotebookEdit": "W"}
_read = {}  # path -> (bytes read, {file: (mode, agent_id, agent_type, ns)})


def files_path(root, sid):
    return os.path.join(root, "sessions", os.path.basename(sid) + ".files")


def record(root, event, now=None):
    """Append the hook event's line, if a tool call of the session read or wrote a file."""
    if event.get("hook_event_name") != "PostToolUse" or event.get("tool_name") not in MODES:
        return
    sid, tin = os.path.basename(str(event.get("session_id") or "")), event.get("tool_input")
    if not sid or not isinstance(tin, dict):
        return
    path = tin.get("notebook_path" if event["tool_name"] == "NotebookEdit" else "file_path")
    if not isinstance(path, str) or not path or "\n" in path or "\r" in path:
        return
    agent = "".join(str(event.get("agent_id") or "-").split()) or "-"
    kind = "_".join(str(event.get("agent_type") or "main").split()) or "main"
    os.makedirs(os.path.join(root, "sessions"), exist_ok=True)
    fd = os.open(files_path(root, sid), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, f"{now or time.time_ns()} {agent} {kind} {MODES[event['tool_name']]} {path}\n".encode())
    finally:
        os.close(fd)


def states(root, sid):
    """{path: (mode, agent_id, agent_type, ns)} for the session; None when it has no record. Only the
    lines added since the last call are read."""
    path = files_path(root, sid)
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    at, got = _read.get(path, (0, {}))
    if size < at:  # a new file in its place
        at, got = 0, {}
    if size > at:
        with open(path, "rb") as f:
            f.seek(at)
            data = f.read()
        done = data.rfind(b"\n") + 1  # a half-written last line waits for the next call
        for line in data[:done].decode(errors="replace").splitlines():
            try:
                t, agent, kind, mode, name = line.split(" ", 4)
                t = int(t)
            except ValueError:
                continue
            old = got.get(name, ("R", "", "", 0))
            if t >= old[3]:
                old = (old[0], agent, kind, t)
            got[name] = ("W" if "W" in (mode, old[0]) else "R", *old[1:])
        _read[path] = (at + done, got)
    return dict(got)


if __name__ == "__main__":
    try:
        record(os.path.join(os.environ.get("TMPDIR", "/tmp"), "steading"), json.loads(sys.stdin.read() or "{}"))
    except (OSError, ValueError, AttributeError):
        pass  # a hook never fails the session
