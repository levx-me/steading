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
import json
import os
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


if __name__ == "__main__":
    try:
        record(os.path.join(os.environ.get("TMPDIR", "/tmp"), "steading"), json.loads(sys.stdin.read() or "{}"))
    except (OSError, ValueError, AttributeError):
        pass  # a hook never fails the session
