#!/usr/bin/env python3
"""Each Claude session's CPU and memory on its herdr agent row: the pane token $usage
("15% 0.6G"), summed over the claude process and everything under it (MCP servers, node, shells).

bin/sidebar.py starts it, one per machine (a pid file, usage.pid, beside the panes' state). Every
10 s it reads every process with one ps call, finds each herdr pane's claude (asked once per pane,
and again when that process is gone), and reports a pane only when its rounded value changed:
CPU to 5%, memory to 0.1 GB, so the sidebar seldom redraws. A pane whose claude has ended has its
token cleared. It exits once no herdr pane runs Claude, or herdr is gone.

    usage.py"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # -I leaves the script's folder out
import reexec, steading_run  # noqa: E402
from procs import is_claude, read_ps, sessions, usage_text  # noqa: E402

EVERY = float(os.environ.get("STEADING_RUN_EVERY", "10"))
ICON = "" if os.environ.get("STEADING_SIDEBAR_ICONS") == "0" else "\uf4bc "  # Nerd Font's cpu
SOURCE = "steading-usage"
BASE = os.path.join(os.environ.get("TMPDIR", "/tmp"), "steading")


def state(pane):
    return os.path.join(BASE, pane.replace(":", "_").replace("/", "_"))


def claude_of(pane):
    """The pid of the claude a pane runs, from herdr's view of its foreground processes, or None."""
    info = steading_run.call("pane.process_info", {"pane_id": pane}).get("process_info", {})
    return next((str(p["pid"]) for p in info.get("foreground_processes", [])
                 if p.get("name") in ("claude", "claude.exe") and os.path.basename(p.get("argv0", "")) == "claude"), None)


def values(procs, pids, was, now):
    """{pane: its token} for {pane: claude pid}; `was` ({pid: (time, cpu seconds)}) is updated, for
    the CPU used since the last round (ps's own % the first time)."""
    found, out = sessions(procs), {}
    for pane, pid in pids.items():
        members = [pid] + [k for k in found.get(pid, []) if k in procs]
        secs, rss = sum(procs[k].secs for k in members), sum(procs[k].rss for k in members)
        if pid in was and now > was[pid][0]:
            cpu = max(0.0, (secs - was[pid][1]) * 100 / (now - was[pid][0]))
        else:
            cpu = sum(procs[k].cpu for k in members)
        was[pid] = (now, secs)
        out[pane] = ICON + usage_text(cpu, rss)
    return out


def report(pane, value):
    tokens = {"usage": value or None}
    if steading_run.same_as_sent(state(pane), SOURCE, tokens):
        return
    steading_run.call("pane.report_metadata", {"pane_id": pane, "source": SOURCE, "tokens": tokens})
    steading_run.mark_sent(state(pane), SOURCE, tokens)


PIDFILE = os.path.join(BASE, "usage.pid")


def running(pidfile=PIDFILE):
    """Whether the pid in pidfile is a live usage.py (a dead pid, or one reused by another
    program, is not)."""
    try:
        with open(pidfile) as f:
            pid = int(f.read())
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    args = subprocess.run(["ps", "-o", "args=", "-p", str(pid)], capture_output=True, text=True).stdout
    return any(os.path.basename(word) == "usage.py" for word in args.split())  # its script, not a command naming it


def claim(pidfile=PIDFILE):
    """Take the pid file, made atomically (O_EXCL) so two starting at once cannot both win; a
    stale one is replaced. False when another usage.py holds it."""
    for _ in range(2):
        try:
            if int(open(pidfile).read()) == os.getpid():
                return True  # re-exec'd: the file is already ours
        except (OSError, ValueError):
            pass
        try:
            fd = os.open(pidfile, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            if running(pidfile):
                return False
            try:
                os.remove(pidfile)
            except OSError:
                pass
            continue
        with os.fdopen(fd, "w") as f:
            f.write(str(os.getpid()))
        return True
    return False


def main():
    pids, was, shown, idle = {}, {}, set(), 0
    check = reexec.watcher()
    while True:
        check()
        procs, now = read_ps(), time.time()
        panes = [p["pane_id"] for p in steading_run.call("pane.list", {}).get("panes", []) if p.get("agent") == "claude"]
        for pane in panes:
            if pids.get(pane) not in procs or not is_claude(procs[pids[pane]]):
                pids[pane] = claude_of(pane)
        pids = {pane: pid for pane, pid in pids.items() if pane in panes and pid in procs}
        found = values(procs, pids, was, now)
        for pane in shown - set(found):  # its claude has ended: no usage on its row
            try:
                report(pane, "")
            except OSError:
                pass
        for pane, value in found.items():
            report(pane, value)
        shown = set(found)
        was = {pid: w for pid, w in was.items() if pid in procs}
        idle = 0 if found else idle + 1
        if idle >= 2:
            return
        time.sleep(EVERY)


if __name__ == "__main__":
    os.makedirs(BASE, exist_ok=True)
    pidfile = PIDFILE
    if not claim():  # one per machine
        sys.exit(0)
    try:
        main()
    except (OSError, ValueError, KeyError):
        pass
    finally:
        try:
            if open(pidfile).read() == str(os.getpid()):
                os.remove(pidfile)
        except OSError:
            pass
