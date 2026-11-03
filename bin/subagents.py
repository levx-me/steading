"""Which subagents are at work, as Claude Code's own hooks say: the one record that the
sidebar's $crew (bin/crew) and the deck's agents section (bin/viewer.py) both read.

bin/sidebar runs this on SubagentStart, SubagentStop, TeammateIdle and SessionStart before
anything it hands to the background, so the lines land in the order the hooks ran. Each event
appends one line to <TMPDIR>/steading/sessions/<session_id>.log:

  <ns> working <agent_id>   SubagentStart: spawned, resumed, or a teammate handed a new message
  <ns> idle <agent_id>      a teammate's SubagentStop, or TeammateIdle: waiting for its next message
  <ns> done <agent_id>      any other subagent's SubagentStop: it has finished
  <ns> clear -              SessionStart of a new process (startup, resume, /clear): the old
                            process's subagents died with it. Compaction keeps them: they still run.

An agent's state is its line with the latest time, whatever order the lines were read in; a
clear stops every agent recorded before it. Transcripts say what an agent does, never whether
it still works: Claude Code writes a turn only when it ends, so one thinking for minutes is silent."""
import calendar
import json
import os
import re
import sys
import time

STALE = 3 * 3600  # "working" this long with no new start: it died without its stop (a crash)
TEAMMATE = "in_process_teammate"  # the meta's taskKind of an agent team's teammate
_read = {}  # log path -> (bytes read, latest clear, {agent: (state, ns)})


def log_path(root, sid):
    return os.path.join(root, "sessions", os.path.basename(sid) + ".log")


def teammate(event, agent):
    """Whether the agent is an agent team's teammate (idle between messages, never done)."""
    meta = event.get("agent_transcript_path") or ""
    meta = meta[:-len(".jsonl")] + ".meta.json" if meta.endswith(".jsonl") else \
        str(event.get("transcript_path", ""))[:-len(".jsonl")] + f"/subagents/agent-{agent}.meta.json"
    try:
        with open(meta) as f:
            return json.load(f).get("taskKind") == TEAMMATE
    except (OSError, ValueError, AttributeError):
        return False


def record(root, event, now=None):
    """Append the hook event's line, if it says anything about the session's subagents."""
    name, sid = event.get("hook_event_name"), os.path.basename(str(event.get("session_id") or ""))
    agent = os.path.basename(str(event.get("agent_id") or ""))
    if name == "SubagentStart" and agent:
        state = "working"
    elif name == "TeammateIdle" and agent:
        state = "idle"
    elif name == "SubagentStop" and agent:
        state = "idle" if teammate(event, agent) else "done"
    elif name == "SessionStart" and event.get("source") in ("startup", "resume", "clear"):
        state, agent = "clear", "-"
    else:
        return
    if not sid:
        return
    os.makedirs(os.path.join(root, "sessions"), exist_ok=True)
    with open(log_path(root, sid), "a") as f:  # one short append: whole, even beside another
        f.write(f"{now or time.time_ns()} {state} {agent}\n")


def states(root, sid, now=None):
    """{agent_id: (state, ns)} for the session: "working", "idle", "done", or "stopped" (cleared
    by a new process, or working so long it must have died); None when the session has no record
    at all (it began before them). Only the lines added since the last call are read."""
    path = log_path(root, sid)
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    at, cleared, got = _read.get(path, (0, 0, {}))
    if size < at:  # a new file in its place
        at, cleared, got = 0, 0, {}
    if size > at:
        with open(path, "rb") as f:
            f.seek(at)
            data = f.read()
        done = data.rfind(b"\n") + 1  # a half-written last line waits for the next call
        for line in data[:done].decode(errors="replace").splitlines():
            try:
                t, state, agent = line.split(" ", 2)
                t = int(t)
            except ValueError:
                continue
            if state == "clear":
                cleared = max(cleared, t)
            elif t > got.get(agent, ("", 0))[1]:
                got[agent] = (state, t)
        _read[path] = (at + done, cleared, got)
    now = now or time.time_ns()
    return {a: ("stopped", t) if t < cleared or (s == "working" and now - t > STALE * 10**9) else (s, t)
            for a, (s, t) in got.items()}


# An agent's own background work, from its transcript: a command it started in the background (Bash
# run_in_background, or one moved there on its timeout) gets a backgroundTaskId in its tool result,
# with the file its output goes to; the task-notification that says it ended names that id. An agent
# whose turn is over gets no notification until it runs again, so the output file says it too: Claude
# Code ends it with "[exited with code N]". The text is matched as bytes, line by line, with no JSON
# parsing; a quoted notification only ends a task early.
LAUNCHED = re.compile(rb'"backgroundTaskId":\s*"([^"]+)"')
OUTPUT = re.compile(rb"Output is being written to: ([^\s\"\\]+?)\.?(?:\s|\\n|\")")
ENDED = re.compile(rb"<task-id>([^<]+)</task-id>")
EXITED = re.compile(rb"\[exited with code -?\d+\]\s*$")
STAMP = re.compile(rb'"timestamp":\s*"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)')


def scan_background(data, launched, ended):
    """Note the launches ({task id: (when, in seconds; its output file)}) and the ends (task ids) in
    data, whole lines of a transcript."""
    for m in LAUNCHED.finditer(data):
        start, end = data.rfind(b"\n", 0, m.start()) + 1, data.find(b"\n", m.end())
        end = end if end >= 0 else len(data)
        at, out = STAMP.search(data, start, end), OUTPUT.search(data, start, end)  # its line's
        try:
            when = calendar.timegm(time.strptime(at.group(1).decode(), "%Y-%m-%dT%H:%M:%S"))
        except (AttributeError, ValueError):
            when = time.time()
        launched[m.group(1).decode()] = (when, out.group(1).decode() if out else "")
    ended.update(m.group(1).decode().strip() for m in ENDED.finditer(data))


def pending(launched, ended, since=0, now=None):
    """The background commands still running, as far as the transcript says: launched, not ended
    (no notification, no exit line in its output), not started before since (the session's latest clear: a new process, so they died with the old
    one) nor over STALE ago."""
    now = now or time.time()
    for t, (at, out) in launched.items():
        if t not in ended and out and exited(out):
            ended.add(t)  # (for good: it is not read again)
    return sorted(t for t, (at, out) in launched.items() if t not in ended and at >= since and now - at < STALE)


def exited(output):
    """Whether a background command's output file ends with Claude Code's "[exited with code N]"."""
    try:
        with open(output, "rb") as f:
            f.seek(max(0, os.path.getsize(output) - 200))
            return bool(EXITED.search(f.read()))
    except OSError:
        return False


def cleared(root, sid):
    """When the session's latest clear was recorded (seconds), 0 for none; after states() read it."""
    return _read.get(log_path(root, sid), (0, 0, {}))[1] / 1e9


_bg = {}  # transcript path -> (bytes read, launched, ended)


def background(path, since=0, now=None):
    """The background commands an agent's transcript says it still runs (see pending). Only the
    bytes added since the last call are read, 16 MB at a time."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return []
    at, launched, ended = _bg.get(path, (0, {}, set()))
    if size < at:  # a new file in its place
        at, launched, ended = 0, {}, set()
    if size > at:
        with open(path, "rb") as f:
            f.seek(at)
            while True:
                data = f.read(1 << 24)
                if len(data) == 1 << 24:
                    data += f.readline()
                done = data.rfind(b"\n") + 1  # a half-written last line waits for the next call
                scan_background(data[:done], launched, ended)
                at += done
                if len(data) < 1 << 24 or done < len(data):
                    break
        _bg[path] = (at, launched, ended)
    return pending(launched, ended, since, now)


if __name__ == "__main__":
    try:
        record(os.path.join(os.environ.get("TMPDIR", "/tmp"), "steading"), json.loads(sys.stdin.read() or "{}"))
    except (OSError, ValueError, AttributeError):
        pass  # a hook never fails the session
