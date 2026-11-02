"""The machine's processes from one ps call, shared by the deck's system tab (bin/viewer.py) and
the sidebar's per-agent CPU and memory (bin/usage.py). The same ps flags work on macOS and on
Linux (procps). Standard library only."""
import collections
import os
import re
import subprocess

PS = ["ps", "-axo", "ucomm=,pid=,ppid=,uid=,user=,pcpu=,rss=,time=,args="]
# The name comes first: it may hold spaces ("Google Chrome He"), the numbers after it cannot.
PS_LINE = re.compile(r"^\s*(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+([\d:.-]+)\s?(.*)$")
# cpu: ps's own %; rss in bytes; secs: the CPU time used so far.
Proc = collections.namedtuple("Proc", "name pid ppid uid user cpu rss secs args")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def printable(text):
    """text with control characters (a terminal would act on them) shown as "?"."""
    return CONTROL.sub("?", text)


def cpu_secs(text):
    """ps's CPU time, [dd-][hh:]mm:ss[.cc], in seconds."""
    days, _, rest = text.rpartition("-")
    secs = 0.0
    for part in rest.split(":"):
        secs = secs * 60 + float(part)
    return secs + int(days or 0) * 86400


def ps_table(text):
    """ps's lines (PS) as {pid: Proc}; a line that does not parse is left out."""
    procs = {}
    for m in filter(None, map(PS_LINE.match, text.splitlines())):
        name, pid, ppid, uid, user, cpu, rss, secs, args = m.groups()
        try:
            procs[pid] = Proc(printable(name), pid, ppid, int(uid), printable(user), float(cpu), int(rss) * 1024, cpu_secs(secs),
                              printable(args[:256]))
        except ValueError:
            pass
    return procs


def read_ps():
    try:
        return ps_table(subprocess.run(PS, capture_output=True, text=True, timeout=5, start_new_session=True).stdout)
    except (OSError, subprocess.SubprocessError):
        return {}


def is_claude(p):
    """A Claude Code session: run as `claude` (macOS names the binary claude.exe, as it does
    Chrome's Claude helper, which is not a session)."""
    return p.name in ("claude", "claude.exe") and os.path.basename(p.args.split(" ", 1)[0]) == "claude"


def program(p):
    """The Program column's name: the executable's, less a trailing .exe (the Claude Code binary is
    claude.exe); but a multi-call binary run under another name (Claude's bundled search shows as
    claude.exe with argv0 ugrep) goes by that name. Only a bare argv0 counts, so a path, a login
    shell's "-zsh" or a name cut by spaces in a path is never taken for one."""
    name = p.name[:-4] if p.name.endswith(".exe") and os.name != "nt" else p.name
    argv0 = p.args.split(" ", 1)[0]
    if argv0 and "/" not in argv0 and not argv0.startswith("-") and argv0 not in (name, p.name):
        return argv0
    return name


def children(procs):
    """{pid: [its children's pids]}."""
    kids = {}
    for p in procs.values():
        kids.setdefault(p.ppid, []).append(p.pid)
    return kids


def under(kids, pid, apart=()):
    """Every pid below pid (MCP servers, node, shells, ...), depth first; a pid in `apart` is left
    out with all below it."""
    out, todo = [], list(kids.get(pid, []))
    while todo:
        child = todo.pop()
        if child != pid and child not in out and child not in apart:
            out.append(child)
            todo += kids.get(child, [])
    return out


def sessions(procs, apart=()):
    """{pid of each Claude session: the pids under it}. A claude started by another session (a
    `claude -p` it runs) counts as part of that one. The pids in `apart` (dev servers, shown on
    rows of their own) are no part of any session, nor is anything under them."""
    kids, found = children(procs), {}
    for pid, p in procs.items():
        if not is_claude(p):
            continue
        up, seen, nested = p.ppid, set(), False
        while up in procs and up not in seen:  # an ancestor that is a session itself
            seen.add(up)
            if is_claude(procs[up]):
                nested = True
                break
            up = procs[up].ppid
        if not nested:
            found[pid] = under(kids, pid, set(apart))
    return found


def usage_text(cpu, rss):
    """A session's CPU and memory for the sidebar, rounded so it changes seldom: CPU to 5%,
    memory to 0.1 GB ("15% 0.6G")."""
    return f"{int(5 * round(cpu / 5))}% {rss / 2**30:.1f}G"
