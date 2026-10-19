#!/usr/bin/env python3
"""Steading deck: one read-only pane beside the agent with seven sections.

    viewer.py <base>

<base>/<kind>/runs/<n>/ holds one run of kind build, test, git or deploy (written by
bin/run and bin/record): cmd, cwd, log, start, pid, and once finished rc and
end. The servers section lists the project's dev servers (bin/servers on
<base>/root). A new run, or a write to <base>/focus naming a section, marks
that section's tab new (red) until it is shown; a new run is also followed live. The jobs section lists
the agent's other commands that ran 10s or more (bin/hook, bin/job), live from
Claude Code's own output file while they run.

Keys: [ ] (or tab/shift-tab) and 1-7 switch sections,
ctrl+c closes the pane (q only leaves a log), L reopens it on the other side of the agent (right or above). In a run section j/k pick a run from the list and enter (or l)
moves into its output; esc comes back. The output takes herdr's copy-mode keys: h j k l, w b e, W B E,
0 ^ $, { }, gg G, ctrl-d/u, v V select, y yank (the line when nothing is
selected), / ? search, n N repeat, esc cancel. Servers work the same way, their
log being the server's output; o opens the selected one in the browser.
Mouse: click a section tab or a run (or server) in the list to switch, click in a log to place the
cursor, wheel to scroll.

Standard library only, so it runs on the python3 that macOS and Linux ship.
Editing this file restarts every open deck with the new code.
"""
import functools
import glob
import json
import os
import re
import select
import shlex
import shutil
import subprocess
import sys
import termios
import textwrap
import threading
import time
import traceback
import tty
import unicodedata
import urllib.parse

BASE = sys.argv[1] if len(sys.argv) > 1 else os.environ["STEADING_BASE"]  # plugin panes pass it in the env
SERVERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "servers")
SECTIONS = ["agents", "jobs", "servers", "build", "test", "git", "deploy"]
FOCUS = {"pane": True}  # whether the deck's pane has the keyboard; without it the accents go grey

# Settings, shared by every deck: the "," popup writes them, each deck rereads them when they change.
SETTINGS_PATH = os.path.join(os.environ.get("HERDR_PLUGIN_CONFIG_DIR")
                             or os.path.expanduser("~/.config/herdr/plugins/config/steading"), "settings.json")
SETTINGS = [  # (key, label, what it does, default, choices: None for on/off)
    ("follow", "Follow new runs", "A new run takes the deck to its tab, instead of marking the tab.", False, None),
    ("open_with_agents", "Open with agents", "A deck opens beside each agent as it starts.",
     True, None),
    ("jobs_threshold", "Jobs threshold", "How long a command runs before the jobs tab shows it.", 10, [5, 10, 30]),
]
CURRENT = {}  # the settings in force, reread by the deck when the file changes


def settings():
    try:
        with open(SETTINGS_PATH) as f:
            saved = json.load(f)
    except (OSError, ValueError):
        saved = {}
    out = {}
    for key, _, _, default, choices in SETTINGS:
        value = saved.get(key, default)
        out[key] = (value if value in choices else default) if choices else bool(value)
    CURRENT.update(out)
    return out


def save_settings(values):
    try:
        os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
        with open(SETTINGS_PATH, "w") as f:
            json.dump(values, f, indent=2)
    except OSError:
        pass
# shift and a letter of the tab's name goes there: its first, but git's I (G is vim's bottom).
TAB_KEYS = ["A", "J", "S", "B", "T", "I", "D"]
# Screen rows (1-based, as in mouse reports): section tabs, then the section's
# head (run list box, command, info line, rule) and its body.
HEAD_ROW = 2
LIST_ROWS = 10  # run list height (rows) before it scrolls

RESET, DIM, BOLD = "\033[0m", "\033[2m", "\033[1m"
STRIP_RGB, TAB_RGB, ACTIVE_RGB = "33;37;43", "44;49;58", "62;68;81"
MUTED_RGB, BRIGHT_RGB = "120;127;140", "220;223;228"
DIMMED_RGB = "88;94;105"  # the side without the cursor: list labels or the log's plain text
GREEN_RGB, RED_RGB, AMBER_RGB, CYAN_RGB = "152;177;125", "208;134;141", "216;180;106", "127;180;180"
ACCENT = {"agents": "143;168;210", "jobs": CYAN_RGB, "servers": GREEN_RGB, "build": AMBER_RGB, "test": "122;162;200", "git": "180;142;173", "deploy": "209;154;102"}
MOUSE = re.compile(r"\x1b\[<(\d+);(\d+);(\d+)([Mm])")
KEYS = re.compile(r"\x1b\[[0-9;]*[A-Za-z~]|\x1bO.|\x1b|.", re.S)
# Arrow keys move as h j k l do, in the list and in the log (normal and application cursor mode).
ARROWS = {"\x1b[A": "k", "\x1b[B": "j", "\x1b[C": "l", "\x1b[D": "h",
          "\x1bOA": "k", "\x1bOB": "j", "\x1bOC": "l", "\x1bOD": "h"}
SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


def background(fn, *args):
    """Run fn in a thread, so the deck never waits on it."""
    threading.Thread(target=fn, args=args, daemon=True).start()


def spinner():
    return SPIN[int(time.time() * 8) % len(SPIN)]


ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


def fg(rgb):
    return f"\033[38;2;{rgb}m"


def bg(rgb):
    return f"\033[48;2;{rgb}m"


def read(path, default=""):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except OSError:
        return default


SGR = re.compile(r"\x1b\[([0-9;]*)m")


def tint(line, rgb):
    """The line faint, its default-coloured text in rgb: text the program
    coloured keeps its hue but loses its brightness, so none of it outshines
    the list."""
    def after(m):
        params = m.group(1).split(";") if m.group(1) else ["0"]
        # Back to the default foreground: a reset or 39 with no colour set after it.
        # A reset or 22 also ends faint, so it goes back on. Bold would outshine
        # faint (and in some terminals cancel it), so it is left out.
        back, faint, kept, i = False, False, [], 0
        while i < len(params):
            p = params[i]
            if p in ("38", "48"):  # extended colour: 38;5;n or 38;2;r;g;b
                n = 5 if params[i + 1:i + 2] == ["2"] else 3
                kept += params[i:i + n]
                back = back and p != "38"
                i += n
                continue
            if p in ("", "0"):
                back = faint = True
            elif p == "22":
                faint = True
            elif p == "39":
                back = True
            elif p.isdigit() and (30 <= int(p) <= 37 or 90 <= int(p) <= 97):
                back = False
            if p != "1":
                kept.append(p)
            i += 1
        seq = f"\033[{';'.join(kept)}m" if kept else ""
        return seq + (fg(rgb) if back else "") + ("\033[2m" if faint else "")
    return fg(rgb) + "\033[2m" + SGR.sub(after, line)


FADE_SECS = 2.5  # a run just added starts in its section's colour and fades to the usual over this


def blend(a, b, f):
    """The colour f of the way from rgb a to rgb b ("r;g;b" each)."""
    pa, pb = [int(n) for n in a.split(";")], [int(n) for n in b.split(";")]
    return ";".join(str(round(x + (y - x) * min(1.0, max(0.0, f)))) for x, y in zip(pa, pb))


def visible_len(s):
    return len(ANSI.sub("", s))


def cells(text):
    """Terminal cells text takes: wide (CJK, Hangul) characters take two."""
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def cut(text, room):
    """text cut to room cells, with … when cut."""
    if cells(text) <= room:
        return text
    out, used = "", 0
    for ch in text:
        w = cells(ch)
        if used + w > room - 1:
            break
        out, used = out + ch, used + w
    return out + "…"


def fit(s, cols):
    """Cut s to cols visible columns, keeping its escape codes, with … when cut."""
    if visible_len(s) <= cols:
        return s
    out, width, pos = [], 0, 0
    for m in ANSI.finditer(s + "\x1b[0m"):
        for ch in s[pos:m.start()]:
            if width >= cols - 1:
                # The mark keeps the line's background and faintness, in the muted grey.
                return "".join(out) + fg(MUTED_RGB) + "…" + RESET
            out.append(ch)
            width += 1
        out.append(m.group())
        pos = m.end()
    return "".join(out)


def rule(cols):
    return f"{DIM}{'─' * cols}{RESET}"


def link(url, text):
    return f"\033]8;;{url}\a{text}\033]8;;\a"


CLOSE_W = 3  # " ✕ " at the tab strip's left end


def strip(cells, cols, active, new=frozenset(), new_rgb=RED_RGB):
    """Lay cells [(width, text)] on a dark strip, scrolled so `active` shows.

    Cells in `new` have something not seen yet: an arrow with such a cell hidden
    behind it turns new_rgb, and the strip ends in a count of them all.
    Returns the line and where each shown cell landed: [(index, first col, last col)],
    columns counted from 1 like mouse reports."""
    count = f" {len(new)} new " if new else ""
    room = cols - 2 - (len(count) + 1 if count else 0)
    first = 0
    while first < active and sum(w + 1 for w, _ in cells[first:active + 1]) > room:
        first += 1
    arrow = lambda hidden: f"{fg(new_rgb)}{BOLD}" if new & set(hidden) else fg(MUTED_RGB)
    out, used, last, spans = [bg(STRIP_RGB), arrow(range(first)), "‹" if first else " ", "\033[22m"], 0, first, []
    for w, text in cells[first:]:
        if used + w + 1 > room:
            break
        spans.append((last, 2 + used, 1 + used + w))
        out += [text, bg(STRIP_RGB), " "]
        used += w + 1
        last += 1
    out.append(f"{arrow(range(last, len(cells)))}{'›' if last < len(cells) else ' '}\033[22m")
    if count:  # how many tabs have something new, wherever they are
        out.append(f"{' ' * max(0, room - used)}{bg(new_rgb)}{fg(BRIGHT_RGB)}{BOLD}{count}\033[22m{bg(STRIP_RGB)}")
    out.append(f"\033[K{RESET}")
    return "".join(out), spans


def git_summary(cmd):
    """`cd x && git add -A && git commit -q -m "Fix it\n\nbody" && git push`
    -> 'git add · git commit "Fix it" · git push', for the run list."""
    return " · ".join(git_steps(cmd))


def _classify():
    """bin/classify, loaded once: the shell-token reading both hooks use."""
    global _CLASSIFY
    if "_CLASSIFY" not in globals():
        from importlib.machinery import SourceFileLoader
        _CLASSIFY = SourceFileLoader("classify", os.path.join(os.path.dirname(os.path.abspath(__file__)), "classify")).load_module()
    return _CLASSIFY


@functools.lru_cache(maxsize=1024)  # pure: same command, same steps
def git_steps(cmd, messages=True):
    """The git steps of cmd, read as shell tokens (quotes kept whole), flags
    dropped, read-only ones left out when there are writes; with messages, a
    commit carries its message's first line."""
    c = _classify()
    heredoc = re.search(r"""<<-?\s*['"]?\w+['"]?\n\s*([^\n]*)""", cmd)  # first line of a heredoc message
    steps, writes = [], []
    for words, _ in c.simple_commands(cmd):
        w = c.unwrap(words)
        if not w or w[0] != "git":
            continue
        args = w[1:]
        while args and args[0] in ("-C", "-c"):
            args = args[2:]
        sub = next((a for a in args if not a.startswith("-")), "")
        step = f"git {sub}".strip()
        if sub == "commit" and messages and "-m" in args[:-1]:
            msg = args[args.index("-m") + 1].strip("'\"")
            if msg.startswith("$(") and heredoc:  # -m "$(cat <<'EOF' ... EOF)"
                msg = heredoc.group(1)
            msg = msg.strip().splitlines()[0].strip() if msg.strip() else "…"
            step += f' "{msg[:40]}…"' if len(msg) > 40 else f' "{msg}"'
        if step not in steps:
            steps.append(step)
        # The steps that change something, by the rule that decides what is recorded.
        if c.git_write(w) and step not in writes:
            writes.append(step)
    return writes or steps


@functools.lru_cache(maxsize=1024)
def commit_message(cmd):
    """The full message of a `git commit` in cmd: from -m "..." (any number of
    lines) or from a heredoc fed to it; "" when there is none."""
    if not re.search(r"\bgit\b[^\n;&|]*\bcommit\b", cmd.split("<<", 1)[0]):  # not in a heredoc body
        return ""
    heredoc = re.search(r"""<<-?\s*['"]?(\w+)['"]?\n(.*?)\n\s*\1\b""", cmd, re.S)
    m = re.search(r"""-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')""", cmd, re.S)
    msg = (m.group(1) or m.group(2) or "") if m else ""
    if (not msg or msg.startswith("$(")) and heredoc:
        msg = heredoc.group(2)
    return msg.replace('\\"', '"').strip()


HASHES = [  # where git prints the commit a command leaves behind
    re.compile(r"^\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]", re.M),    # commit: [main 1a2b3c4] msg
    re.compile(r"\b[0-9a-f]{7,40}\.\.\.?([0-9a-f]{7,40})\b"),            # push/pull/fetch: a..b
    re.compile(r"HEAD is now at ([0-9a-f]{7,40})\b"),                     # reset, checkout
    re.compile(r"^([0-9a-f]{7,40}) \S", re.M),                            # log --oneline after a quiet commit
]


def git_hash(text):
    """Short hash of the last commit the output mentions, or ""."""
    found = []
    for pattern in HASHES:
        found += [(m.start(), m.group(1)) for m in pattern.finditer(text)]
    return max(found)[1][:7] if found else ""


def exit_code(rc):
    """'exit N' for the info line, a failure's in red at full strength (the line is dim)."""
    return "exit 0" if rc == "0" else f"\033[22m{fg(RED_RGB)}exit {rc}{fg(MUTED_RGB)}{DIM}"


class Run:
    def __init__(self, path):
        self.path = path
        self.full = read(os.path.join(path, "cmd"))
        self.tag = read(os.path.join(path, "label"))  # "forge test", from the agent's description
        if not self.tag and os.path.basename(os.path.dirname(os.path.dirname(path))) == "git":
            self.tag = git_summary(self.full)
        # For the run list, one line: a multi-line command (a heredoc, say) gets ⏎ marks.
        self.cmd = " ⏎ ".join(self.full.splitlines())
        self.is_git = os.path.basename(os.path.dirname(os.path.dirname(path))) == "git"
        # The log, read in a background thread and kept until the file changes.
        self._log = (None, None, None, "")  # (file key, display lines, plain lines, hash)
        self._loading = None

    def fixed(self, name, default=""):
        """One of the run's files that never changes once written (rc, end, start, cwd, ...):
        read until it is there, then kept, so a frame does not reopen every row's files."""
        known = self.__dict__.setdefault("_fixed", {})
        if name not in known:
            value = read(os.path.join(self.path, name))
            if not value:
                return default
            known[name] = value
        return known[name]

    def source(self):
        """Claude's task output file, for a run sent to the background (not kept:
        bin/record removes it when a job ends, and the log takes over)."""
        return read(os.path.join(self.path, "source"))

    def rc(self):
        """Exit code, or "" while running. A background run's code is the
        "[exited with code N]" line Claude Code appends to its output file."""
        rc = self.fixed("rc") or getattr(self, "_tail_rc", "")
        if rc:
            return rc
        src = self.source()
        if not src:
            return ""
        try:
            with open(src, "rb") as f:
                f.seek(max(0, os.path.getsize(src) - 200))
                tail = f.read().decode("utf-8", "replace")
        except OSError:
            return ""
        m = re.search(r"\[exited with code (\d+)\]\s*$", tail)
        if m:
            self._tail_rc = m.group(1)
        return m.group(1) if m else ""

    def status(self):
        if getattr(self, "dead", False):  # died without an exit code: it stays that way
            return ("⊘", MUTED_RGB)
        rc = self.rc()
        if rc:
            return ("✓", GREEN_RGB) if rc == "0" else ("✗", RED_RGB)
        if self.source():
            return (spinner(), AMBER_RGB)  # background run still going
        try:
            os.kill(int(self.fixed("pid", "0")), 0)
            return (spinner(), AMBER_RGB)
        except (OSError, ValueError):
            self.dead = True
            return ("⊘", MUTED_RGB)  # the runner died without an exit code

    def label(self):
        kind = os.path.basename(os.path.dirname(os.path.dirname(self.path)))
        if kind in ("test", "build", "deploy"):  # in words; its header keeps the command
            return command_phrase(self.tag or self.full, "", kind)
        if self.tag:
            return self.tag
        cmd = re.sub(r"^cd \S+ && ", "", self.cmd)
        cmd = re.sub(r"^([A-Za-z_]\w*=\S* )+", "", cmd)
        return re.sub(r"^(npx|bunx|pnpm( exec| dlx)?|yarn|uv run|poetry run|python3? -m) ", "", cmd)

    def age(self):
        """'running 4s' while it runs, else how long ago it finished."""
        end = self.end()
        if not end:
            start = int(self.fixed("start", "0") or 0)
            return f"running {took(time.time() - start)}" if start else "running"
        s = int(time.time()) - int(end)
        for unit, size in (("d", 86400), ("h", 3600), ("m", 60)):
            if s >= size:
                return f"{s // size}{unit} ago"
        return f"{s}s ago"

    CMD_LINES = 8  # longest command shown before it is cut

    MSG_LINES = 15  # longest commit message shown

    def command(self, cols):
        """The run's label, or else its whole command, wrapped to the pane.
        A git commit also shows its whole message."""
        is_git = os.path.basename(os.path.dirname(os.path.dirname(self.path))) == "git"
        steps = git_steps(self.full, messages=False) if is_git else []
        if steps:  # one line per git step, the commit's whole message under it
            message = commit_message(self.full)
            rows = []
            for step in steps:
                rows.append(f"{BOLD}$ {step}{RESET}")
                if step == "git commit" and message:
                    lines = []
                    for line in message.splitlines():
                        lines += textwrap.wrap(line, max(10, cols - 4)) or [""]
                    if len(lines) > self.MSG_LINES:
                        lines = lines[:self.MSG_LINES - 1] + [f"… {len(lines) - self.MSG_LINES + 1} more lines"]
                    rows += [f"{fg(ACCENT['git'])}  │ {RESET}{l}" for l in lines]
            return rows
        if self.tag:
            rows = [f"{BOLD}{r}{RESET}" for r in textwrap.wrap(self.tag, max(10, cols), initial_indent="$ ",
                                                             subsequent_indent="    ")]
            if self.full.strip() != self.tag.strip():  # the real command, dimmed, two rows at most
                full = textwrap.wrap(" ⏎ ".join(self.full.splitlines()), max(10, cols - 2))
                rows += [f"{DIM}  {r}{RESET}" for r in full[:2]]
                if len(full) > 2:
                    rows[-1] = rows[-1][:-len(RESET)] + "…" + RESET
            return rows
        rows = []
        for i, line in enumerate(self.full.splitlines() or [""]):
            rows += textwrap.wrap(line.expandtabs(4), max(10, cols), initial_indent="$ " if i == 0 else "  ",
                                  subsequent_indent="    ", drop_whitespace=False) or ["  "]
        if len(rows) > self.CMD_LINES:
            rows = rows[:self.CMD_LINES - 1] + [f"{DIM}  … {len(rows) - self.CMD_LINES + 1} more lines{RESET}"]
        return [f"{BOLD}{r}{RESET}" if not r.startswith(DIM) else r for r in rows]

    def end(self):
        """When it finished: the end file, or a finished background run's output mtime."""
        end = self.fixed("end")
        if not end and self.source() and self.rc():
            try:
                end = str(int(os.path.getmtime(self.source())))
            except OSError:
                pass
        return end

    def hash(self):
        """For git runs, the commit it left behind (from its output); "" until read."""
        if not self.is_git:
            return ""
        self.lines()
        return self._log[3]

    def full_hash(self):
        """The whole hash behind the short one, looked up once (in a thread) in
        the run's repo; "" until found."""
        short = self.hash()
        if short and not hasattr(self, "_full"):
            self._full = ""
            threading.Thread(target=self._find_full, args=(short,), daemon=True).start()
        return getattr(self, "_full", "")

    def _find_full(self, short):
        cwd = self.fixed("cwd")
        # Every directory the command cd's into (newest last wins), then its cwd.
        cds = [os.path.join(cwd, os.path.expanduser(d.strip("'\""))) for d in re.findall(r"(?:^|[;&|(\n]\s*)cd\s+(\S+)", self.full)]
        for d in [*reversed(cds), cwd]:
            try:
                out = subprocess.run(["git", "-C", d, "rev-parse", "--verify", "--quiet", short + "^{commit}"],
                                     capture_output=True, text=True, timeout=2).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                out = ""
            if re.fullmatch(r"[0-9a-f]{40}", out):
                self._full = out
                break

    def info(self):
        """Where, how long, and how it ended."""
        start = int(self.fixed("start", "0") or 0)
        end = self.end()
        rc = self.rc()
        parts = [self.fixed("cwd").replace(os.path.expanduser("~"), "~", 1)]
        branch = self.fixed("branch")
        if branch:
            parts.append(f"on {branch}")
        if start:
            parts.append(f"{(int(end) if end else int(time.time())) - start}s")
        parts.append(exit_code(rc) if rc else "running in the background" if self.source() else "running")
        return f"{DIM}  {' · '.join(p for p in parts if p)}{RESET}"

    MAX_BYTES = 2_000_000  # a bigger log shows its last 2 MB

    def lines(self):
        """Display lines of the log, or None while it is first being read.
        Reading happens in a thread and only when the file changed (mtime and
        size), so switching tabs never waits on a big log."""
        path = self.source() or os.path.join(self.path, "log")
        try:
            st = os.stat(path)
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            return []
        if key != self._log[0] and self._loading != key:
            self._loading = key
            threading.Thread(target=self._load, args=(path, key), daemon=True).start()
        return self._log[1]

    def plain(self):
        self.lines()
        return self._log[2] or []  # none read yet: a log that is gone (a job's, say) or not there

    def _load(self, path, key):
        try:
            with open(path, "rb") as f:
                size = os.fstat(f.fileno()).st_size
                cut = size > self.MAX_BYTES
                if cut:
                    f.seek(size - self.MAX_BYTES)
                data = f.read()
        except OSError:
            data, cut = b"", False
        text = data.decode("utf-8", "replace")
        if cut:  # drop the partial first line and say so
            text = f"{DIM}… earlier output cut ({size // 1_000_000} MB log){RESET}\n" + text.split("\n", 1)[-1]
        text = re.sub(r"\n*\[exited with code \d+\]\s*$", "", text)
        shown = clean(text, git=self.is_git)
        plain = [ANSI.sub("", l) for l in shown]
        sha = git_hash("\n".join(plain)) if self.is_git else ""
        self._log = (key, shown, plain, sha)  # one assignment: readers see old or new, never half
        if self._loading == key:
            self._loading = None


_panes = (0.0, [])
def herdr_panes(fresh=False):
    """Every herdr pane as (pane id, workspace id, shell pid, tty), looked up
    at most every 10s unless fresh. Call it from a thread: it asks herdr once per pane."""
    global _panes
    if not fresh and time.time() - _panes[0] < 10:
        return _panes[1]
    herdr = os.environ.get("HERDR_BIN_PATH", "herdr")

    def ask(*args):
        try:
            out = subprocess.run([herdr, *args], capture_output=True, text=True, timeout=3).stdout
            return json.loads(out).get("result", {})
        except (OSError, subprocess.SubprocessError, ValueError):
            return {}
    found = []
    for pane in ask("pane", "list").get("panes", []):
        shell = ask("pane", "process-info", "--pane", pane["pane_id"]).get("process_info", {}).get("shell_pid")
        if shell:
            tty = subprocess.run(["ps", "-o", "tty=", "-p", str(shell)], capture_output=True, text=True).stdout.strip()
            found.append((pane["pane_id"], pane.get("workspace_id", ""), str(shell), tty))
    _panes = (time.time(), found)
    return found


class ServerRun(Run):
    """A dev server in the servers list. Its log is wherever its output goes:
    a file (a server Claude sent to the background writes to its task output)
    or the herdr pane whose terminal it prints to."""

    def __init__(self, port, pid, cmd):
        self.port, self.pid = port, pid
        self.path, self.tag, self.is_git = "", "", False
        self.full = self.cmd = re.sub(r"^\S*/", "", cmd.strip())  # /long/path/Python -m x -> Python -m x
        self._log, self._loading, self._read_at = (None, None, None, ""), None, 0.0
        self.hold = False  # set while the user reads the log: a pane log is not re-read under them
        self.where = None  # ("file", path) | ("pane", pane id) | ("none", why); None while looking
        threading.Thread(target=self._find, daemon=True).start()

    def _find(self):
        """Follow stdout up the process tree (a dev server's workers write to a
        pipe their parent reads) until it is a file or a terminal."""
        pid = self.pid
        for _ in range(8):
            out = subprocess.run(["lsof", "-a", "-p", pid, "-d", "1", "-Fn"], capture_output=True, text=True).stdout
            name = next((l[1:] for l in out.splitlines() if l.startswith("n")), "")
            if name.startswith("/dev/tty"):
                def on_tty(panes):
                    return next((p for p, _, _, tty in panes if tty and name == "/dev/" + tty), None)
                pane = on_tty(herdr_panes()) or on_tty(herdr_panes(fresh=True))  # a pane opened since the last look
                self.where = ("pane", pane) if pane else ("none", f"it prints to {name}, outside herdr")
                return
            if os.path.isfile(name):
                self.where = ("file", name)
                return
            pid = subprocess.run(["ps", "-o", "ppid=", "-p", pid], capture_output=True, text=True).stdout.strip()
            if pid in ("", "0", "1"):
                break
        self.where = ("none", "its output goes nowhere the deck can read")

    def source(self):
        return self.where[1] if self.where and self.where[0] == "file" else ""

    def rc(self):
        return ""

    def status(self):
        return ("●", GREEN_RGB)

    def age(self):
        return f":{self.port}"

    def end(self):
        return ""

    def info(self):
        url = f"http://localhost:{self.port}"
        where = {"file": "log file", "pane": f"pane {self.where[1]}"}.get(self.where[0], "") if self.where else ""
        return f"  {link(url, fg(CYAN_RGB) + url + RESET)}{DIM} · pid {self.pid}{' · ' + where if where else ''}{RESET}"

    def lines(self):
        if self.where is None:
            return None
        kind, what = self.where
        if kind == "file":
            return super().lines()
        if kind == "none":
            self._log = (None, [f"{DIM}no log: {what}{RESET}"], [f"no log: {what}"], "")
        elif time.time() - self._read_at >= 1 and not self._loading and not self.hold:  # a pane: read it every second
            self._read_at, self._loading = time.time(), True
            threading.Thread(target=self._read_pane, args=(what,), daemon=True).start()
        return self._log[1]

    def _read_pane(self, pane):
        try:
            text = subprocess.run([os.environ.get("HERDR_BIN_PATH", "herdr"), "pane", "read", pane, "--source", "recent",
                                   "--lines", "2000", "--format", "ansi"], capture_output=True, text=True, timeout=3).stdout
        except (OSError, subprocess.SubprocessError):
            text = ""
        shown = clean(text.rstrip("\n"))
        self._log = (None, shown, [ANSI.sub("", l) for l in shown], "")
        self._loading = None


CSI = re.compile(r"\x1b\[([0-9;?]*)[ -/]*([@-~])")
OTHER = re.compile(r"\x1b\](?!8;)[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]|[\x00-\x06\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]")
GIT_COLOURS = [  # plain git output gets the colours git would use on a terminal
    (re.compile(r"^(\+\+\+|---) "), BOLD),
    (re.compile(r"^@@"), fg(CYAN_RGB)),
    (re.compile(r"^\+"), fg(GREEN_RGB)),
    (re.compile(r"^-"), fg(RED_RGB)),
    (re.compile(r"^(commit [0-9a-f]{7,}|[0-9a-f]{7,40} )"), fg(AMBER_RGB)),
    (re.compile(r"^( ?[MADRCU?]{1,2} )"), fg(GREEN_RGB)),
    (re.compile(r"^(fatal|error|hint):"), fg(RED_RGB)),
]


def clean(text, git=False):
    """Log text to display lines: carriage returns resolved, only colour (SGR)
    and link (OSC 8) codes kept, and colours carried across line breaks."""
    out, state = [], []
    for line in text.split("\n"):
        line = line.rstrip("\r")
        if "\r" in line:  # a carriage return redraws the line: keep what was drawn last
            line = line.rsplit("\r", 1)[-1]
        line = OTHER.sub("", line)
        start = "".join(state)
        kept = []
        pos = 0
        for m in CSI.finditer(line):
            kept.append(line[pos:m.start()])
            pos = m.end()
            if m.group(2) != "m":
                continue  # cursor moves, erases: meaningless in a log
            kept.append(m.group(0))
            state = [] if m.group(1) in ("", "0") else state + [m.group(0)]
        kept.append(line[pos:])
        line = "".join(kept)
        if git and "\x1b[" not in line:
            for pattern, colour in GIT_COLOURS:
                if pattern.search(line):
                    line = colour + line + RESET
                    break
        out.append(start + line)
    while out and not ANSI.sub("", out[-1]).strip():  # no cursor on trailing blank lines
        out.pop()
    return out


def char_class(ch, big):
    """0 blank, 1 word char, 2 punctuation; WORD motions (big) merge 1 and 2."""
    if ch.isspace():
        return 0
    return 1 if big or ch.isalnum() or ch == "_" else 2


def copy(text):
    """Put text on the clipboard: pbcopy, wl-copy or xclip, else OSC 52."""
    for cmd in (["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"]):
        if shutil.which(cmd[0]):
            subprocess.run(cmd, input=text.encode(), check=False)
            return
    import base64
    sys.stdout.write(f"\033]52;c;{base64.b64encode(text.encode()).decode()}\a")


# Runs whose box opens with a status header, a summary and a gutter of line numbers.
REPORTED = {"jobs", "build", "test", "deploy"}
# A log line that reports an error, or a warning ("0 failed" is neither).
ERROR_LINE = re.compile(r"\w*error(s)?\b|(?<![\w-])(fail|failed|failure|panic|fatal)\b|✗|✘|×", re.I)
WARN_LINE = re.compile(r"(?<![\w-])(warn|warning|warnings|deprecated)\b", re.I)
NO_PROBLEM = re.compile(r"\b0 (errors?|fail(ed|ures?)?|warnings?)\b", re.I)


def line_mark(line):
    """"error", "warn" or "" for a plain log line."""
    line = NO_PROBLEM.sub("", line)  # "0 failed", "0 errors": nothing wrong said there
    return "error" if ERROR_LINE.search(line) else "warn" if WARN_LINE.search(line) else ""


def test_counts(plain):
    """(passed, failed, skipped) from a test runner's closing summary near the end of
    its log (vitest, jest, pytest, cargo, forge, bun, mocha, ...), or None.
    ponytail: a regex sweep of the last lines; add a runner's own form when it reads wrong."""
    found = {}
    for line in reversed(plain[-40:]):
        for key, pattern in (("passed", r"(\d+)\s+(?:tests?\s+)?pass(?:ed|ing|es)?\b"),
                             ("failed", r"(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ures?|s)?\b"),
                             ("skipped", r"(\d+)\s+(?:tests?\s+)?(?:skip(?:ped)?|pending|todo)\b")):
            m = re.search(pattern, line, re.I)
            if m and key not in found:
                found[key] = int(m.group(1))
        if "passed" in found and ("failed" in found or len(found) > 1):
            break
    if "passed" not in found and "failed" not in found:
        return None
    return found.get("passed", 0), found.get("failed", 0), found.get("skipped", 0)


def status_words(kind, icon, rgb):
    """The header's badge: what the run's status means for its kind."""
    if rgb == AMBER_RGB:
        return "RUNNING"
    if icon == "⊘":
        return "STOPPED"
    if rgb == RED_RGB:
        return "FAILED"
    return {"test": "PASSED", "build": "BUILT", "deploy": "DEPLOYED"}.get(kind, "DONE")


# What an empty tab says: a title, and where its runs come from.
EMPTY = {
    "agents": ("No Claude Code session", "The agent and its subagents show here once a session starts in this pane."),
    "jobs": ("No long-running commands", "Commands that run past the jobs threshold (10s, set with ,) show here, live."),
    "servers": ("No dev servers running", "Ports opened by this project, or from any pane of its herdr workspace, show here."),
    "build": ("No builds yet", "npm run build, tsc, cargo build, … show here as the agent runs them."),
    "test": ("No test runs yet", "npm test, pytest, go test, forge test, … show here as the agent runs them."),
    "git": ("No git changes yet", "Commits, pushes and other changes to the repository show here."),
    "deploy": ("No deploys yet", "vercel, fly deploy, terraform apply, … show here once they have run."),
}


class Runs:
    """One run section (build, test or git): run tabs and the log under a
    copy-mode cursor, with the same keys as herdr's copy mode."""

    noun = "runs"
    run_class = Run
    dim_unfocused = True  # the output reads faint while the cursor is in the list
    copy_cursor = True    # in the output, herdr's copy-mode cursor

    def __init__(self, kind):
        self.kind, self.dir = kind, os.path.join(BASE, kind, "runs")
        self.runs, self.known, self.tab = [], None, 0
        self.offset, self.follow = 0, True
        self.cy = self.cx = 0              # cursor line / column in the plain text
        self.anchor, self.linewise = None, False  # visual selection start
        self.pending = ""                  # "g" waiting for its second g
        self.search, self.query, self.back = None, "", False  # None = not typing
        self.msg = ""
        self.raw, self.plain, self.height = [], [], 1
        self.focus = "list"                # "list": j/k pick runs; "log": copy-mode cursor
        self.part, self.saved = "log", {}  # which part of the run the cursor is in: "log" or "head" (its command)

    def refresh(self):
        """Reload the runs; True when a new one appeared since the last look."""
        try:
            ns = sorted(int(n) for n in os.listdir(self.dir) if n.isdigit())
        except OSError:
            ns = []
        ns = [n for n in ns if self.shows(os.path.join(self.dir, str(n)))]
        new = self.known is not None and any(n not in self.known for n in ns)
        if self.known is None or new:  # start on, and jump to, the newest run
            self.select(len(ns) - 1)
        self.known = set(ns)
        # Keep Run objects (and their loaded logs) across refreshes.
        cache = {r.n: r for r in self.runs if hasattr(r, "n")}
        self.runs = [cache.get(n) or self.run_class(os.path.join(self.dir, str(n))) for n in ns]
        for n, r in zip(ns, self.runs):
            r.n = n
        if new:
            self.fresh = (self.runs[-1], time.time())
        self.tab = max(0, min(self.tab, len(self.runs) - 1))
        return new

    def select(self, tab):
        self.tab, self.follow, self.anchor, self.msg = tab, True, None, ""
        self.part, self.saved = "log", {}

    def switch_part(self):
        """tab / shift+tab in the output: the cursor goes between the run's command lines and its log."""
        self.saved[self.part] = (self.cy, self.cx, self.offset, self.follow)
        self.part = "head" if self.part == "log" else "log"
        self.cy, self.cx, self.offset, self.follow = self.saved.get(self.part, (0, 0, 0, False))
        self.anchor = None

    def title_right(self):
        """Text for the right end of the run list's top border."""
        return ""

    def place_cursor(self):
        """Where the output's cursor goes before the frame scrolls to it: pinned to the
        end while the run grows, or while the cursor is in the list."""
        if self.follow or self.focus == "list":
            self.cy = max(0, len(self.plain) - 1)

    def shows(self, path):
        """Whether the run in path is listed."""
        return True

    def badge(self):
        return self.runs[-1].status() if self.runs else ("·", MUTED_RGB)

    # cursor ----------------------------------------------------------------

    def clamp(self):
        last = max(0, len(self.plain) - 1)
        self.cy = max(0, min(self.cy, last))
        width = len(self.plain[self.cy]) if self.plain else 0
        self.cx = max(0, min(self.cx, max(0, width - 1)))

    def at(self, y, x):
        line = self.plain[y] if 0 <= y < len(self.plain) else ""
        return line[x] if 0 <= x < len(line) else "\n"

    def step(self, y, x, forward):
        """Next / previous position across lines, a line break counting as blank."""
        if forward:
            if x + 1 < len(self.plain[y]):
                return y, x + 1
            return (y + 1, -1) if y + 1 < len(self.plain) else None
        if x > 0:
            return y, x - 1
        return (y - 1, len(self.plain[y - 1])) if y > 0 else None

    def word(self, motion, big):
        y, x = self.cy, self.cx
        cls = lambda p: char_class(self.at(*p), big)
        if motion == "w":  # past this word, then past blanks
            start = cls((y, x))
            while (n := self.step(y, x, True)) and cls(n) == start and start:
                y, x = n
            while (n := self.step(y, x, True)):
                y, x = n
                if cls((y, x)):
                    break
        elif motion == "e":  # off this spot, past blanks, to the word's end
            if (n := self.step(y, x, True)):
                y, x = n
            while cls((y, x)) == 0 and (n := self.step(y, x, True)):
                y, x = n
            c = cls((y, x))
            while (n := self.step(y, x, True)) and cls(n) == c:
                y, x = n
        else:  # "b": back past blanks, to the word's start
            if (n := self.step(y, x, False)):
                y, x = n
            while cls((y, x)) == 0 and (n := self.step(y, x, False)):
                y, x = n
            c = cls((y, x))
            while (n := self.step(y, x, False)) and cls(n) == c:
                y, x = n
        self.cy, self.cx = y, max(0, x)

    def paragraph(self, down):
        y = self.cy + (1 if down else -1)
        while 0 <= y < len(self.plain) and self.plain[y].strip():
            y += 1 if down else -1
        self.cy, self.cx = max(0, min(y, len(self.plain) - 1)), 0

    def find(self, backwards):
        if not self.query:
            return
        q = self.query
        fold = q.islower()
        lines = [l.lower() for l in self.plain] if fold else self.plain
        n = len(lines)
        for i in range(n + 1):
            y = (self.cy - i) % n if backwards else (self.cy + i) % n
            line = lines[y]
            if i == 0:
                x = line.rfind(q, 0, self.cx) if backwards else line.find(q, self.cx + 1)
            else:
                x = line.rfind(q) if backwards else line.find(q)
            if x >= 0:
                self.cy, self.cx, self.msg = y, x, ""
                return
        self.msg = f"not found: {q}"

    def selection(self):
        """Selected text, or the cursor line when nothing is selected."""
        if self.anchor is None:
            return self.plain[self.cy] + "\n" if self.plain else ""
        (y0, x0), (y1, x1) = sorted([self.anchor, (self.cy, self.cx)])
        if self.linewise:
            return "\n".join(self.plain[y0:y1 + 1]) + "\n"
        if y0 == y1:
            return self.plain[y0][x0:x1 + 1]
        return "\n".join([self.plain[y0][x0:]] + self.plain[y0 + 1:y1] + [self.plain[y1][:x1 + 1]])

    def selected(self, y, x):
        if self.anchor is None:
            return False
        (y0, x0), (y1, x1) = sorted([self.anchor, (self.cy, self.cx)])
        if not y0 <= y <= y1:
            return False
        if self.linewise:
            return True
        return (y > y0 or x >= x0) and (y < y1 or x <= x1)

    # drawing ---------------------------------------------------------------

    def frame(self, cols, rows):
        """The run list box, then a box filling the rest with the run: its command,
        info and log (an agent: its detail). Each box's border takes the section's
        colour while the cursor is in it."""
        # A short pane (a deck on top of its agent) keeps a shorter list, so the log still shows.
        self.list_rows = max(3, min(LIST_ROWS, (rows - 10) // 2))
        if not self.runs:
            return self.empty_frame(cols, rows), []
        outer, cols = cols, max(10, cols - 4)  # inside the box: "│ " … " │"
        run = self.runs[self.tab]
        run.cols = cols  # agents lay their status out to the box
        loaded = run.lines()
        log_raw = loaded if loaded is not None else [f"{DIM}loading…{RESET}"]
        # An agent's detail is drawn anew each time: its plain lines come from these very lines.
        log_plain = [ANSI.sub("", l) for l in loaded] if isinstance(run, AgentRun) else \
            run.plain() if loaded is not None else [""]
        head = self.run_list(outer)
        box = len(head)
        if self.search is not None:
            info = f"{fg(ACCENT[self.kind])}{'?' if self.back else '/'}{RESET}{self.search}▏"
        else:
            # (not while selecting in the command lines themselves: the line would shift under the cursor)
            mode = ("-- VISUAL LINE -- " if self.linewise else "-- VISUAL -- ") \
                if self.anchor and self.part != "head" else ""
            note = f"{fg(AMBER_RGB)}{self.msg}{RESET}  " if self.msg else ""
            info = f"{BOLD}{mode}{RESET}{note}{run.info()}"
        # The run's own lines above its log: command, info, commit (agents have none).
        reported = self.kind in REPORTED and not isinstance(run, (AgentRun, ServerRun))
        if reported:
            head_lines = self.header(run, cols, log_plain)  # badge, then (maybe) a summary
            extras = head_lines[:1] + run.command(cols) + head_lines[1:]
            if self.search is not None or self.msg or (self.anchor and self.part != "head"):
                extras.append(info)  # a search being typed, a note, the selection mode
        else:
            extras = [] if isinstance(run, AgentRun) else [*run.command(cols), info]
        if run.hash():  # the whole hash, on its own line so a narrow pane does not cut it
            extras.append(f"{DIM}  commit {fg(ACCENT['git'])}{run.full_hash() or run.hash()}{RESET}")
        # tab / shift+tab in the output move the cursor between these and the log.
        self.has_head = bool(extras)
        self.log_empty = not any(l.strip() for l in log_plain)
        if extras and self.focus == "log" and self.part == "log" and self.log_empty:
            self.part = "head"  # nothing in the log (yet): the cursor goes on the command lines
        in_head = self.part == "head" and bool(extras) and self.focus == "log"
        if not in_head:
            self.part = "log"
        self.raw, self.plain = (extras, [ANSI.sub("", l) for l in extras]) if in_head else (log_raw, log_plain)
        if in_head and getattr(self, "to_end", None) is not None and self.to_end is not False:
            column, self.to_end = self.to_end, None
            self.cy = max(0, len(self.plain) - 1)
            last = max(0, len(self.plain[self.cy]) - 1)
            self.cx = last if column is True else min(column, last)  # True: its last character
        cursor = self.focus == "log" and self.copy_cursor

        running = run.status()[1] == AMBER_RGB and not isinstance(run, AgentRun)  # agents have no output
        # While it runs, the last row shows a spinner under the output.
        room = max(1, rows - (HEAD_ROW - 1) - box - 2)  # the run's box, inside its borders
        ruled = 1 if extras else 0
        height = max(1, room - len(extras) - ruled - (1 if running else 0))
        self.height = len(extras) if in_head else height
        self.place_cursor()
        self.clamp()
        if self.cy < self.offset:
            self.offset = self.cy
        elif self.cy >= self.offset + self.height:
            self.offset = self.cy - self.height + 1
        self.offset = max(0, min(self.offset, max(0, len(self.plain) - self.height)))
        # Mouse rows: the cursor's section starts here (under the box's top border).
        self.body_row = HEAD_ROW + box + 1 + (0 if in_head else len(extras) + ruled)

        # A reported run's log has a gutter: line numbers, a red or amber bar on error and warning lines.
        digits = len(str(len(log_plain))) if reported else 0
        self.gutter = digits + 2 if reported and not in_head else 0

        def number(plain, y):
            """A reported log's gutter for line y: its number and a bar, red on errors, amber on warnings."""
            mark = line_mark(plain[y]) if y < len(plain) else ""
            bar = f"{fg(RED_RGB)}▌" if mark == "error" else f"{fg(AMBER_RGB)}▌" if mark == "warn" else f"{fg('70;76;88')}│"
            return f"{fg(DIMMED_RGB)}{y + 1:>{digits}}{bar}{RESET} "

        def drawn(raw, plain, first, last, marks, gutter=False):
            out = drawn_lines(raw, plain, first, last, marks)
            if not gutter:
                return out
            for n, y in enumerate(range(first, first + len(out))):
                out[n] = number(plain, y) + out[n]
            return out

        def drawn_lines(raw, plain, first, last, marks):
            out = []
            tip = self.tooltip_at(cols) if marks else None
            for y in range(first, min(len(raw), last)):
                if tip and y == tip[0]:  # the tooltip sits on this row, over its text
                    _, x, label = tip
                    line = plain[y].ljust(x)
                    out.append(f"{line[:x]}{bg(ACCENT[self.kind])}{fg(STRIP_RGB)}{BOLD}{label}{RESET}{line[x + len(label):]}")
                elif marks and ((cursor and y == self.cy) or self.selected(y, 0) or self.selected(y, len(plain[y]) - 1)):
                    out.append(self.marked(y))
                else:
                    # It reads dim while the cursor is in the list.
                    out.append(tint(raw[y], DIMMED_RGB) if self.focus == "list" and self.dim_unfocused else raw[y])
            return out

        top = drawn(extras, self.plain if in_head else [ANSI.sub("", l) for l in extras], 0, len(extras), in_head)
        # The cursor's line, when wider than the box, unfolds onto the rows under it; the
        # other lines stay cut. The view moves down to keep all of it in sight.
        # While a selection is made (v, V, a drag) the line unfolded when it began stays so,
        # and no other unfolds: rows would move under the cursor and the mouse.
        selecting = self.anchor is not None
        was, self.unfold = self.unfold, None
        line = (was[0] if was else None) if selecting else self.cy
        pieces = []
        if cursor and not in_head and line is not None and line < len(log_plain):
            pieces = unfold_pieces(log_plain[line], max(10, cols - self.gutter))
            if len(pieces) > 1:
                extra = min(len(pieces) - 1, height - 1)
                pieces = pieces[:extra + 1]
                if not selecting and line - self.offset + 1 + extra > height:
                    self.offset = line + 1 + extra - height
                self.unfold = (line, extra)
        log_offset = self.saved.get("log", (0, 0, 0))[2] if in_head else self.offset
        body = drawn(log_raw, log_plain, log_offset, log_offset + height, not in_head, gutter=reported)
        if self.unfold and 0 <= self.unfold[0] - log_offset < len(body):
            line = self.unfold[0]
            at = line - log_offset
            rows = []
            for n, (start, piece) in enumerate(pieces):
                lead = (number(log_plain, line) if n == 0 else " " * self.gutter) if reported else ""
                rows.append(lead + self.marked(line, start, start + len(piece)))  # selection and cursor shown
            body = (body[:at] + rows + body[at + 1:])[:height]
        head += top + ([rule(cols)] if extras else [])
        if running:
            start = int(read(os.path.join(run.path, "start"), "0") or 0)
            secs = f" {int(time.time()) - start}s" if start else ""
            body.append(f"{fg(AMBER_RGB)}{spinner()} running{secs}{RESET}")
        # The run's box: all the rest of the pane, bordered in the section's colour while it has the cursor.
        return head[:box] + self.boxed(head[box:] + body, outer, room, self.focus == "log"), []

    def header(self, run, cols, plain):
        """A reported run's head: its status as a badge with where, how long and when on
        the right; then for a test run its passed/failed bar, for others its error and
        warning count."""
        icon, rgb = run.status()
        badge = f"{bg(rgb)}{fg(STRIP_RGB)}{BOLD} {icon} {status_words(self.kind, icon, rgb)} \033[22m{RESET}"
        meta = ANSI.sub("", run.info()).strip().replace(" · exit 0", "")  # the badge says it went well
        end = run.end()
        if end and not isinstance(run, JobRun):
            meta += f" · {time.strftime('%H:%M', time.localtime(int(end)))}"
        room = cols - visible_len(badge) - 1
        meta = cut(meta, max(4, room))
        lines = [badge + " " * max(1, cols - visible_len(badge) - cells(meta)) + f"{fg(MUTED_RGB)}{meta}{RESET}"]
        counts = test_counts(plain) if self.kind == "test" else None
        if counts:
            passed, failed, skipped = counts
            total = passed + failed + skipped
            width = max(5, min(24, cols - 40))
            parts = [f"{fg(GREEN_RGB)}{passed} passed"] + ([f"{fg(RED_RGB)}{failed} failed"] if failed else []) + \
                ([f"{fg(MUTED_RGB)}{skipped} skipped"] if skipped else [])
            lines.append(f"{bar([(passed, GREEN_RGB), (failed, RED_RGB), (skipped, TAB_RGB)], width)}  "
                         + f"{fg(MUTED_RGB)} · ".join(parts) + f"{fg(MUTED_RGB)} · {total} total{RESET}")
        elif self.kind != "test":
            marks = [line_mark(l) for l in plain]
            errors, warns = marks.count("error"), marks.count("warn")
            if errors or warns:
                lines.append(" · ".join(([f"{fg(RED_RGB)}▌ {errors} error line{'s' * (errors != 1)}"] if errors else [])
                                        + ([f"{fg(AMBER_RGB)}▌ {warns} warning{'s' * (warns != 1)}"] if warns else [])) + RESET)
        return lines

    def boxed(self, lines, cols, room, lit):
        """lines in a rounded box cols wide and room rows tall inside, its border in
        the section's colour when lit."""
        inner = max(10, cols - 4)
        edge = fg(ACCENT[self.kind]) if lit and FOCUS["pane"] else fg("70;76;88")
        out = [f"{edge}╭{'─' * (inner + 2)}╮{RESET}"]
        for line in (lines + [""] * room)[:room]:
            line = fit(line, inner)
            out.append(f"{edge}│{RESET} {line}{RESET}{' ' * max(0, inner - cells(ANSI.sub('', line)))} {edge}│{RESET}")
        return out + [f"{edge}╰{'─' * (inner + 2)}╯{RESET}"]

    def empty_frame(self, cols, rows):
        """A tab with nothing yet: its empty list, then what will show here and how, centred."""
        title, hint = EMPTY[self.kind]
        edge, inner = fg(ACCENT[self.kind] if FOCUS["pane"] else "70;76;88"), max(10, cols - 4)
        head = f" {self.noun} · 0 "
        right = self.title_right()
        if cols - 4 - len(head) - visible_len(right) < 1:
            right = ""
        fill = max(0, cols - 4 - len(head) - visible_len(right)) + (0 if right else 1)
        top = f"{edge}╭─{fg(MUTED_RGB)}{head}{edge}{'─' * fill}{right}{edge}{'─' if right else ''}╮{RESET}"
        listed = [top, f"{edge}│{RESET}{' ' * (cols - 2)}{edge}│{RESET}", f"{edge}╰{'─' * (cols - 2)}╯{RESET}"]
        room = max(1, rows - (HEAD_ROW - 1) - len(listed) - 2)
        icon = {"agents": "◇", "jobs": "◷", "servers": "◉", "build": "▣", "test": "✓", "git": "⎇", "deploy": "⇪"}[self.kind]
        message = [f"{fg(ACCENT[self.kind])}{icon}", f"{BOLD}{fg(BRIGHT_RGB)}{title}{RESET}", ""] + \
            [f"{fg(MUTED_RGB)}{part}" for part in wrap_cells(hint, max(10, min(inner - 4, 48)))]
        centred = [" " * max(0, (inner - cells(ANSI.sub("", l))) // 2) + l for l in message]
        top_pad = max(0, (room - len(centred)) // 2)
        return listed + self.boxed([""] * top_pad + centred, cols, room, False)

    def tooltip_at(self, cols):
        """(log line, column, label) of a live copy tooltip: on the line above the
        selection, from its first column, or below it when that line is off screen."""
        text, until = getattr(self, "tooltip", None) or ("", 0)
        if until < time.time() or self.anchor is None:
            return None
        (y0, x0), (y1, _) = sorted([self.anchor, (self.cy, self.cx)])
        label = f" {text} "
        row = y0 - 1 if y0 - 1 >= self.offset else y1 + 1
        return row, max(0, min(x0, cols - len(label))), label

    def run_list(self, cols):
        """The runs in a rounded box, newest on top, the one on show raised;
        scrolls past LIST_ROWS. The border takes the accent while the list has
        the focus."""
        edge = fg(ACCENT[self.kind]) if self.focus == "list" and FOCUS["pane"] else fg("70;76;88")
        inner = cols - 2
        title = f" {self.noun} · {len(self.runs)} "
        right = self.title_right()
        if inner - 2 - len(title) - visible_len(right) < 1:  # too narrow: the count alone
            right = ""
        fill = max(0, inner - 2 - len(title) - visible_len(right)) + (0 if right else 1)
        top = f"{edge}╭─{fg(MUTED_RGB)}{title}{edge}{'─' * fill}{right}{edge}{'─' if right else ''}╮{RESET}"
        rows = [f"{edge}│{RESET}{line}{RESET}{edge}│{RESET}" for line in self.rows(inner)]
        return [top, *rows, f"{edge}╰{'─' * inner}╯{RESET}"]

    def rows(self, cols):
        """List rows, each exactly cols wide. A git run takes one row per git
        step; status, age and hash sit on its first row. Scrolls by rows, keeping
        the selected run in view; self.listed maps each row to its run."""
        entries = []  # (run index, first row of the run?, text)
        for i in range(len(self.runs) - 1, -1, -1):
            run = self.runs[i]
            steps = git_steps(run.full) if self.kind == "git" else []
            for n, text in enumerate(steps or [run.label()]):
                entries.append((i, n == 0, text))
            # A second row (agents: what it is doing), when the list has the room.
            if hasattr(run, "subline") and getattr(self, "list_rows", LIST_ROWS) >= 6:
                entries.append((i, False, run.subline()))
        at = next(n for n, (i, first, _) in enumerate(entries) if i == self.tab)
        span = sum(1 for i, _, _ in entries if i == self.tab)
        most = getattr(self, "list_rows", LIST_ROWS)
        top = max(0, min(at - max(0, (most - span) // 2), len(entries) - most))
        shown_entries = entries[top:top + most]
        self.listed = [i for i, _, _ in shown_entries]

        # Agents: model and time make one right-hand column, the text on both rows kept clear of it.
        column = max((len(t[1]) if isinstance(t, tuple) else len(self.runs[i].top_right()))
                     for i, _, t in shown_entries) if self.kind == "agents" else 0
        lines = []
        for i, first, label in shown_entries:
            run = self.runs[i]
            selected = i == self.tab
            if first:
                icon, colour = run.status()
                age = getattr(run, "top_right", run.age)()  # agents: their model
                # git rows keep a fixed 7-column hash at the far right (blank when
                # there is none), so the variable-width age lines up before it.
                sha = run.hash()
                branch = run.fixed("branch") if self.kind == "git" else ""  # the branch it ran on
                if branch:  # a long branch gives way before the message does: a quarter of the row at most
                    branch = cut(branch, max(8, cols // 4))
                right = f"{branch}  {age}  {sha:7}" if branch else f"{age}  {sha:7}" if self.kind == "git" else age
                shown = (f"{fg(DIMMED_RGB)}{branch}{fg(MUTED_RGB)}  " if branch else "") + \
                    (f"{age}  {fg(ACCENT['git'])}{sha:7}" if self.kind == "git" else age)
            elif isinstance(label, tuple):  # a run's second row: its own text and right-hand side
                (label, right, shown), icon, colour = label, " ", MUTED_RGB
            else:
                icon, colour, right, shown = " ", MUTED_RGB, "", ""
            sub = not first and bool(right)
            # "➜ ✓ label<gap>right " and "  ✓ label<gap>right " both fill the line.
            fixed = 5
            # A first row keeps the right-hand column clear; a second row only its own right
            # side, so a row without a task bar uses that space for its text.
            room = cols - fixed - 1 - (len(right) + 2 if sub else max(len(right), column + 2 if column else 0))
            label = cut(label, max(2, room))
            gap = " " * max(1, cols - fixed - cells(label) - len(right))
            # A run just added: its row starts in the section's colour and fades to the usual.
            fresh, at = getattr(self, "fresh", (None, 0))
            fade = (time.time() - at) / FADE_SECS if run is fresh else 1
            if selected or fade < 1:
                # The arrow only while the list is grey (the cursor in the log): whose output it is.
                arrow = fg(MUTED_RGB) + ("➜" if first and self.focus == "log" else " ")
                # The selected row stands out while the list has the focus, and steps back while the log has it.
                ground = ACTIVE_RGB if self.focus == "list" else TAB_RGB
                back = blend(ACCENT[self.kind], ground, fade) if fade < 1 else ground
                ink = STRIP_RGB if fade < 0.5 else BRIGHT_RGB  # dark on the bright start, then light
                weight = "" if sub else BOLD
                ink = MUTED_RGB if sub and fade >= 0.5 else ink
                lines.append(f"{bg(back)}{arrow}{fg(ink if fade < 0.5 else colour)} {icon} {fg(ink)}{weight}{label}"
                             f"\033[22m{gap}{fg(ink if fade < 0.5 else MUTED_RGB)}{ANSI.sub('', shown) if fade < 0.5 else shown} {RESET}")
            else:
                # Labels bright while the cursor is in the list, dim while it is in the log.
                text = BRIGHT_RGB if self.focus == "list" else DIMMED_RGB
                text = MUTED_RGB if sub and self.focus == "list" else text
                lines.append(f"  {fg(colour)}{icon} {fg(text)}{label}{fg(MUTED_RGB)}{gap}{shown} {RESET}")
        return lines

    def marked(self, y, start=0, end=None):
        """A plain line (or its start:end piece) with the selection shaded and the cursor in reverse."""
        line = self.plain[y] or " "
        out = []
        for x, ch in enumerate(line[start:end], start):
            if y == self.cy and x == self.cx:
                out.append(f"\033[7m{ch}\033[27m")
            elif self.selected(y, x):
                out.append(f"{bg('74;84;104')}{ch}\033[49m")
            else:
                out.append(ch)
        return "".join(out)

    # input -----------------------------------------------------------------

    def key(self, k):
        if not self.runs:
            return
        if self.search is not None:  # typing a search
            if k in ("\r", "\n"):
                self.query, self.search = self.search, None
                self.find(self.back)
            elif k == "\x1b":
                self.search = None
            elif k in ("\x7f", "\x08"):
                self.search = self.search[:-1]
            elif k.isprintable():
                self.search += k
            return

        if self.focus == "list":
            self.list_key(k)
            return

        if self.pending == "g":
            self.pending = ""
            if k == "g":
                self.cy, self.cx, self.follow = 0, 0, False
            return

        self.msg = ""
        if k in ("\t", "\x1b[Z"):
            self.switch_part()
            return
        # The box reads as one text, the command lines then the log: h (←) at the very first
        # character steps out of a part (from the command lines to the list, from the log to
        # the command lines' end), l (→) at the command lines' last character into the log.
        if self.anchor is None and k == "h" and self.cy == 0 and self.cx == 0:
            if self.part == "head" or not getattr(self, "has_head", False):
                self.focus = "list"
            else:
                self.switch_part()
                self.to_end = True  # the next frame puts the cursor on the command lines' last character
            return
        # j (↓) on the command lines' last line goes down into the log's first line, k (↑) on the
        # log's first line up to the command lines' last; the column stays where it can.
        if self.anchor is None and k == "j" and self.part == "head" and self.cy >= len(self.plain) - 1 \
                and not getattr(self, "log_empty", False):
            column = self.cx
            self.switch_part()
            self.cy, self.cx, self.offset, self.follow = 0, column, 0, False
            return
        # k (↑) on the box's first line (the command lines', or a log without them) goes back to the list.
        if self.anchor is None and k == "k" and self.cy == 0 \
                and (self.part == "head" or not getattr(self, "has_head", False)):
            self.focus = "list"
            return
        if self.anchor is None and k == "k" and self.part == "log" and self.cy == 0 \
                and getattr(self, "has_head", False):
            column = self.cx
            self.switch_part()
            self.to_end = column  # the next frame puts the cursor on the command lines' last line
            return
        if self.anchor is None and k == "l" and self.part == "head" and self.plain \
                and self.cy == len(self.plain) - 1 and self.cx >= len(self.plain[self.cy]) - 1:
            self.switch_part()
            self.cy = self.cx = self.offset = 0  # the log's first character
            self.follow = False
            return
        if k in ("\r", "\n") and self.plain:  # enter on a control line of the log ([… more], [less])
            getattr(self.runs[self.tab], "activate", lambda line: False)(self.plain[self.cy])
            return
        half = max(1, self.height // 2)
        moves = {
            "j": lambda: setattr(self, "cy", self.cy + 1),
            "k": lambda: setattr(self, "cy", self.cy - 1),
            "h": lambda: setattr(self, "cx", self.cx - 1),
            "l": lambda: setattr(self, "cx", self.cx + 1),
            "0": lambda: setattr(self, "cx", 0),
            "$": lambda: setattr(self, "cx", len(self.plain[self.cy]) if self.plain else 0),
            "^": lambda: setattr(self, "cx", len(self.plain[self.cy]) - len(self.plain[self.cy].lstrip()) if self.plain else 0),
            "w": lambda: self.word("w", False), "W": lambda: self.word("w", True),
            "b": lambda: self.word("b", False), "B": lambda: self.word("b", True),
            "e": lambda: self.word("e", False), "E": lambda: self.word("e", True),
            "{": lambda: self.paragraph(False), "}": lambda: self.paragraph(True),
            "\x04": lambda: setattr(self, "cy", self.cy + half),
            "\x15": lambda: setattr(self, "cy", self.cy - half),
            "n": lambda: self.find(self.back), "N": lambda: self.find(not self.back),
        }
        if k in moves:
            self.follow = False
            moves[k]()
            self.clamp()
            # Moving to the very end of a live run picks the live tail back up.
            self.follow = k in ("j", "\x04") and self.cy >= len(self.plain) - 1 and self.anchor is None
        elif k == "G":
            self.follow, self.cx = True, 0
        elif k == "g":
            self.pending = "g"
        elif k in ("v", "V"):
            if self.anchor and self.linewise == (k == "V"):
                self.anchor = None
            else:
                self.anchor = self.anchor or (self.cy, self.cx)
                self.linewise = k == "V"
                self.follow = False
        elif k == "y":
            text = self.selection()
            copy(text)
            lines = text.count("\n") + (0 if text.endswith("\n") else 1)
            self.msg, self.anchor = f"yanked {lines} line{'s' if lines != 1 else ''}", None
        elif k == "\x1b":
            if self.anchor is not None:
                self.anchor = None
            else:  # nothing to cancel: back to the run list
                self.focus, self.follow = "list", True
        elif k in ("/", "?"):
            self.search, self.back = "", k == "?"

    def hints(self):
        if self.search is not None:
            return [("enter", "find"), ("esc", "cancel")]
        if self.focus == "list":
            return [("L", "side"), ("[ ]", "tabs"), (",", "settings"), ("ctrl+c", "close")]
        return [("hjkl w b", "move"), ("tab", "command/log"), ("v/V", "select"), ("y", "copy"), ("/ ?", "search"),
                ("esc/q", "back")]

    def list_key(self, k):
        """Keys while the run list has the focus (newest run on top)."""
        if self.pending == "g":
            self.pending = ""
            if k == "g":
                self.select(len(self.runs) - 1)
            return
        if k == "j":  # down the list: an older run
            self.select(max(0, self.tab - 1))
        elif k == "k":  # up the list: a newer run
            self.select(min(len(self.runs) - 1, self.tab + 1))
        elif k == "g":
            self.pending = "g"
        elif k == "G":  # the bottom of the list: the oldest run
            self.select(0)
        elif k in ("\r", "\n", "l"):  # into the output, cursor on its last line
            self.focus, self.follow, self.cx = "log", False, 0

    def click(self, row, col):
        """A click on the run list opens that run; in the log it moves the cursor."""
        listed = getattr(self, "listed", [])
        if self.runs and 0 <= row - HEAD_ROW - 1 < len(listed):  # below the box's top border
            # A click opens the run, as enter does: the cursor goes into its output.
            self.select(listed[row - HEAD_ROW - 1])
            self.focus, self.follow, self.cx = "log", True, 0  # at the end of its output
        elif row >= getattr(self, "body_row", 99) and self.plain:
            self.focus, self.anchor = "log", None
            # "│ " before it, and a reported log's gutter
            self.cy, self.cx, self.follow = self.log_line(row), col - 3 - getattr(self, "gutter", 0), False
            self.clamp()
            self.dragging = (self.cy, self.cx)
            if getattr(self.runs[self.tab], "activate", lambda line: False)(self.plain[self.cy]):
                self.dragging = None  # a click on a control is not the start of a selection

    unfold = None  # (log line, extra rows) while the cursor's long line is unfolded

    def log_line(self, row):
        """The log line on a screen row, past the rows the cursor's unfolded line takes."""
        line = self.offset + row - self.body_row
        unfold = getattr(self, "unfold", None)
        if unfold and line > unfold[0]:
            line = unfold[0] if line <= unfold[0] + unfold[1] else line - unfold[1]
        return line

    def drag(self, row, col):
        """Dragging in the log selects from where the button went down, as in herdr."""
        if getattr(self, "dragging", None) is None:
            return
        self.cy, self.cx = self.log_line(row), col - 3 - getattr(self, "gutter", 0)
        self.clamp()
        self.anchor, self.linewise = self.dragging, False

    def release(self):
        """Letting go copies what was dragged over (herdr's copy on select); it stays marked."""
        if getattr(self, "dragging", None) is not None and self.anchor is not None:
            text = self.selection()
            copy(text)
            # A tooltip over the selection for a moment, not a note in the info line.
            self.tooltip = (f"copied {len(text)} character{'s' if len(text) != 1 else ''}", time.time() + 1.5)
        self.dragging = None

    def wheel(self, down, row=0):
        """The wheel over the run list moves through the runs, as j/k do; elsewhere it scrolls the log."""
        if self.runs and HEAD_ROW < row <= HEAD_ROW + len(getattr(self, "listed", [])):
            self.focus = "list"
            self.list_key("j" if down else "k")
            return
        self.focus, self.follow = "log", False
        self.cy += 3 if down else -3
        self.clamp()
        if down and self.cy >= len(self.plain) - 1:
            self.follow = True


class JobRun(Run):
    """A command the agent ran outside the deck, followed live from Claude
    Code's output file (source) until bin/record files its log and exit code."""

    def label(self):
        """The agent's description, else the command in words, as the agents tab shows it."""
        return self.tag or command_phrase(self.full, self.fixed("cwd"))

    def limit(self):
        """The call's timeout in seconds (Claude Code's default is 2 minutes)."""
        return int(self.fixed("timeout", "120000") or 120000) // 1000

    def stopped(self):
        """Gone without bin/record hearing how it ended (interrupted, say)."""
        if self.rc():
            return False
        start = int(self.fixed("start", "0") or 0)
        return not os.path.exists(self.source()) or time.time() > start + self.limit() + 15

    def status(self):
        if getattr(self, "dead", False):
            return ("⊘", MUTED_RGB)
        if self.rc():
            return super().status()
        if self.stopped():  # gone without an end: it stays that way
            self.dead = True
            return ("⊘", MUTED_RGB)
        return (spinner(), AMBER_RGB)

    def age(self):
        """How long it ran, then how long ago it ended: '1m 32s · 5m ago' (running: 'running 12s')."""
        if self.stopped():
            return "stopped"
        start, end = int(self.fixed("start", "0") or 0), self.end()
        return f"{took(int(end) - start)} · {super().age()}" if end and start else super().age()

    def info(self):
        start = int(self.fixed("start", "0") or 0)
        end, rc = self.end(), self.rc()
        limit = self.limit()
        ran = took((int(end) if end else int(time.time())) - start)
        parts = [self.fixed("cwd").replace(os.path.expanduser("~"), "~", 1)]
        if rc:
            parts += [f"ran {ran}", exit_code(rc)]
        elif self.stopped():
            parts += ["stopped"]
        else:
            parts += [f"{ran} of {took(limit)}", "running"]
        return f"{DIM}  {' · '.join(p for p in parts if p)}{RESET}"


class Jobs(Runs):
    """The agent's other commands (not tests or builds, which run in the deck)
    that have taken the jobs threshold (10s unless set) or more, running or done."""

    noun = "jobs"
    run_class = JobRun

    def __init__(self):
        super().__init__("jobs")

    ended = {}  # run path: how long it took, once it has ended (its files no longer change)

    @staticmethod
    def shows(path):
        took = Jobs.ended.get(path)
        if took is None:  # still running (or not looked at yet): read its times
            start = read(os.path.join(path, "start"))
            if not start:
                return False  # not started yet (or waiting on a permission prompt)
            end = read(os.path.join(path, "end"))
            if not end:
                return time.time() - int(start) >= CURRENT.get("jobs_threshold", 10)
            took = Jobs.ended[path] = int(end) - int(start)
        return took >= CURRENT.get("jobs_threshold", 10)


class Git(Runs):
    """The git runs, with the repository's state in the list's border: branch,
    commits not pushed (↑) or not pulled (↓), files not committed. Read every 3s."""

    def __init__(self):
        super().__init__("git")
        self.repo, self.looked_at, self.reading = "", 0.0, False

    def refresh(self):
        if time.time() - self.looked_at >= 3 and not self.reading:
            self.reading, self.looked_at = True, time.time()
            background(self.read_repo)
        return super().refresh()

    def read_repo(self):
        try:
            self.repo = repo_state(read(os.path.join(BASE, "root")))
        finally:
            self.reading = False

    def title_right(self):
        return self.repo


def repo_state(root):
    """' main ↑2 ↓1 · 3 changed ' in colour, from git status; "" outside a repository."""
    try:
        out = subprocess.run(["git", "-C", root, "status", "--porcelain=v2", "--branch"],
                             capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if not root or out.returncode:
        return ""
    branch, ahead, behind, changed = "", 0, 0, 0
    for line in out.stdout.splitlines():
        if line.startswith("# branch.head "):
            branch = line.split(" ", 2)[2]
        elif line.startswith("# branch.ab "):
            a, b = line.split()[2:4]
            ahead, behind = int(a), -int(b)
        elif not line.startswith("#"):
            changed += 1
    parts = [f"{fg(ACCENT['git'])}{branch}"]
    if ahead:
        parts.append(f" {fg(AMBER_RGB)}↑{ahead}")
    if behind:
        parts.append(f" {fg(ACCENT['test'])}↓{behind}")
    parts.append(f"{fg(MUTED_RGB)} · " + (f"{fg(AMBER_RGB)}{changed} changed" if changed else f"{fg(GREEN_RGB)}clean"))
    return f" {''.join(parts)} "


class Servers(Runs):
    """The dev servers of the project, or started from this workspace, as a run
    list with each server's log under it; rescanned every 2s."""

    noun = "servers"

    def __init__(self):
        super().__init__("servers")
        self.found, self.looked_at, self.scanning = [], 0.0, False

    def refresh(self):
        # lsof takes ~0.2s: scan in a thread so the deck never waits on it.
        if time.time() - self.looked_at >= 2 and not self.scanning:
            self.scanning = True
            threading.Thread(target=self.scan, daemon=True).start()
        # Keep each server's object (and its log) and the one picked; lowest port on top.
        keep = {(r.port, r.pid): r for r in self.runs}
        picked = (self.runs[self.tab].port, self.runs[self.tab].pid) if self.runs else None
        self.runs = [keep.get((port, pid)) or ServerRun(port, pid, cmd)
                     for port, pid, cmd in sorted(self.found, key=lambda s: -int(s[0]))]
        keys = [(r.port, r.pid) for r in self.runs]
        # A server that came up since the last scan: picked, and fresh (its row fades in).
        # The ones already up when the deck first looks are not new.
        seen = getattr(self, "seen", None)
        born = [k for k in keys if seen is not None and k not in seen]
        if born:
            self.select(keys.index(born[-1]))
            self.fresh = (self.runs[keys.index(born[-1])], time.time())
        elif picked in keys:
            self.tab = keys.index(picked)
        elif self.runs:
            self.select(len(self.runs) - 1)
        if self.looked_at:  # once a scan has answered
            self.seen = set(keys)
        return False

    def scan(self):
        root, out = read(os.path.join(BASE, "root")), ""
        # The shells of the agent's workspace: servers started from any of them count too.
        agent = os.path.basename(BASE).replace("_", ":")
        panes = herdr_panes()
        ws = next((w for p, w, _, _ in panes if p == agent), None)
        shells = [shell for _, w, shell, _ in panes if ws and w == ws]
        if root:
            try:
                out = subprocess.run([SERVERS, root, *shells], capture_output=True, text=True, timeout=5).stdout
            except (OSError, subprocess.SubprocessError):
                pass
        self.found = [l.split("\t", 2) for l in out.splitlines() if l.count("\t") == 2]
        self.looked_at, self.scanning = time.time(), False

    def badge(self):
        return ("●", GREEN_RGB) if self.runs else ("·", MUTED_RGB)

    def frame(self, cols, rows):
        # Reading the log (not following its end): a pane log stays as it was until
        # esc, since each re-read of the pane's last lines would slide it under the cursor.
        for i, run in enumerate(self.runs):
            run.hold = i == self.tab and self.focus == "log" and not self.follow
        return super().frame(cols, rows)

    def hints(self):
        if self.focus == "list" and self.search is None:
            return [("o", "browser"), ("L", "side"), ("[ ]", "tabs"), (",", "settings"), ("ctrl+c", "close")]
        return super().hints()

    def list_key(self, k):
        if k == "o" and self.runs:
            opener = "open" if sys.platform == "darwin" else "xdg-open"
            subprocess.Popen([opener, f"http://localhost:{self.runs[self.tab].port}"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            super().list_key(k)


# Agents ---------------------------------------------------------------------
# The agent itself and its Claude Code subagents at work, read from its session
# on disk the way zoetrope does (github.com/furkankly/zoetrope):
#   ~/.claude/projects/<project>/<session>.jsonl            the main transcript
#   ~/.claude/projects/<project>/<session>/subagents/       one transcript per subagent,
#       agent-<id>.jsonl + agent-<id>.meta.json             (type, description, toolUseId, depth),
#       workflows/<run>/agent-<id>.jsonl                    the agents of a workflow run.
# A foreground subagent has ended when the main transcript answers its Agent call
# (tool_result for its toolUseId; is_error = failed); a background one when a
# <task-notification> names it. Otherwise it is at work while its file moves.

LIVE_SECS = 300  # a subagent unended and silent this long is no longer at work
HARNESS_TOOLS = {"SubagentHandback"}  # the harness's own steps, not the agent's work
NOTIFICATION = re.compile(r"<task-id>([^<]+)</task-id>.*?<status>([^<]+)</status>", re.S)


def datetime_epoch(ts):
    from datetime import datetime
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


STAMP = re.compile(rb'"timestamp":"([0-9T:.\-]+Z)"')
BEAT_SECS = 10  # one heartbeat column: this many seconds of transcript writes
SPARK = " ▁▂▃▄▅▆▇█"


def unfold_pieces(text, width):
    """A long line cut into pieces width cells wide (wide characters count two):
    [(index of its first character, piece)]."""
    pieces, start, used = [], 0, 0
    for i, ch in enumerate(text):
        w = cells(ch)
        if used + w > width and i > start:
            space = text.rfind(" ", start, i)  # at a word's end where there is one
            cut = space + 1 if space >= start and space + 1 > start + width // 2 else i
            pieces.append((start, text[start:cut]))
            start, used = cut, cells(text[cut:i])
        used += w
    pieces.append((start, text[start:]))
    return pieces


def took(secs):
    secs = int(max(0, secs))
    if secs >= 3600:
        return f"{secs // 3600}h {secs % 3600 // 60}m"
    if secs >= 60:
        return f"{secs // 60}m {secs % 60}s" if secs % 60 else f"{secs // 60}m"
    return f"{secs}s"


def heartbeat(stamps, width):
    """Transcript writes over the last width × BEAT_SECS seconds, a column each, newest on the right."""
    now = time.time()
    beats = [0] * width
    for t in stamps:
        col = width - 1 - int((now - t) // BEAT_SECS)
        if 0 <= col < width:
            beats[col] += 1
    top = max(beats) or 1
    return "".join(SPARK[min(8, -(-n * 8 // top))] if n else SPARK[0] for n in beats)


def status_block(state, colour, icon, since, stamps, cols):
    """An agent's state at a glance: a coloured pill, how long, and a heartbeat of
    its transcript writes over the last minutes (one column per BEAT_SECS)."""
    now = time.time()
    pill = f"{bg(colour)}{fg(STRIP_RGB)}{BOLD} {icon} {state.upper()} {RESET}"
    lines = [f" {pill}{fg(MUTED_RGB)}  {since}{RESET}", ""]
    width = max(10, cols - 2)
    spark = heartbeat(stamps, width)
    span = f"{width * BEAT_SECS // 60}m ago"
    lines += [f" {fg(colour)}{spark}{RESET}",
              f" {fg(MUTED_RGB)}{span}{' ' * max(1, width - len(span) - 3)}now{RESET}"]
    return lines


TOOL_KINDS = {"Read": "read", "NotebookRead": "read", "Grep": "search", "Glob": "search", "WebSearch": "search",
              "WebFetch": "search", "ToolSearch": "search", "Edit": "edit", "MultiEdit": "edit", "Write": "edit",
              "NotebookEdit": "edit", "Bash": "run", "Agent": "agent", "Task": "agent", "Workflow": "agent"}
KIND_RGB = {"read": "122;162;200", "search": CYAN_RGB, "edit": AMBER_RGB, "run": GREEN_RGB, "agent": "180;142;173",
            "other": MUTED_RGB}
CONTEXT_LIMIT = 200_000  # tokens; a "[1m]" model has 1,000,000


GIT_VERBS = {"status": "Checking what changed", "diff": "Looking at the changes", "log": "Reading the history",
             "show": "Looking at a commit", "add": "Staging changes", "push": "Pushing", "pull": "Pulling",
             "fetch": "Fetching", "merge": "Merging", "rebase": "Rebasing", "checkout": "Switching branch",
             "switch": "Switching branch", "branch": "Looking at branches", "stash": "Stashing changes",
             "reset": "Resetting", "tag": "Tagging", "clone": "Cloning", "ls-remote": "Asking the remote"}
SETUP = re.compile(r"(cd|export|set|source|\.|unset|true|:|echo|printf|mkdir)\b")  # steps around the real one
HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?")


PICKS = {"--match-path", "--match-test", "--match-contract", "-k", "-t", "--filter", "-p", "--package",
         "--test-name-pattern", "--grep", "-g", "--testNamePattern", "--spec"}  # flags naming what to test
TOOLS = {"npm", "pnpm", "yarn", "bun", "npx", "bunx", "cargo", "go", "forge", "make", "uv", "poetry",
         "python", "python3", "dotnet", "mvn", "gradle", "swift", "deno", "docker", "turbo", "nx"}


def run_phrase(kind, prog, args, where=lambda p: p):
    """A test, build or deploy command in words: what it tests or builds, not how
    ("Testing hook.test.ts", "Running all the tests", "Building for release", "Deploying to production")."""
    picked, names, skip = [], [], False
    for i, a in enumerate(args):
        if skip:
            skip = False
        elif a in PICKS and i + 1 < len(args):
            picked.append(args[i + 1].strip("'\""))
            skip = True
        elif a.startswith("-") and "=" in a and a.split("=")[0] in PICKS:
            picked.append(a.split("=", 1)[1].strip("'\""))
        elif not a.startswith("-") and a not in ("test", "build", "run", "deploy", ".") and a not in TOOLS:
            names.append(os.path.basename(where(a).rstrip("/")) or a)
    if kind == "test":
        what = names + picked
        if not what:
            return "Running all the tests"
        return f"Testing {', '.join(what[:2])}" + (f" and {len(what) - 2} more" if len(what) > 2 else "")
    if kind == "deploy":
        return "Deploying to production" if {"--prod", "--production", "production", "prod"} & set(args) \
            else f"Deploying with {prog}"
    tag = next((args[i + 1] for i, a in enumerate(args[:-1]) if a in ("-t", "--tag")), "")
    if prog == "docker":
        return f"Building the image {tag}".strip()
    if prog not in TOOLS:  # ./build.sh, a script of its own
        return f"Running {prog}"
    release = {"--release", "--prod", "--production", "production"} & set(args)
    return f"Building {names[0]}" + (" for release" if release else "") if names else \
        "Building for release" if release else "Building the project"


def command_phrase(command, cwd="", kind=""):
    """A command with no description, in words: what its main step does to what
    ("Listing docs", "Committing: Fix X", "Running the tests with bun")."""
    # The script's own lines, here-documents left out, each step the head of its pipe.
    lines, end = [], None
    for line in command.strip().splitlines():
        if end:
            end = None if line.strip() == end else end
            continue
        lines.append(line)
        found = HEREDOC.search(line)
        end = found[1] if found else None
    steps = [p.split("|")[0].strip() for p in re.split(r"&&|\|\||;|\n", "\n".join(lines))]
    steps = [p for p in steps if p and not p.startswith("#")]
    work = [p for p in steps if not SETUP.match(p)]
    # The main step: a commit if there is one, else the last that does the work.
    step = next((p for p in work if re.match(r"git commit\b", p)), work[-1] if work else steps[0] if steps else "")
    line = step
    try:
        words = shlex.split(step)
    except ValueError:
        words = step.split()
    while words and re.match(r"[A-Za-z_]\w*=", words[0]):  # FOO=1 cmd
        words = words[1:]
    if not words:
        return line
    home = os.path.expanduser("~")
    def where(p):
        p = os.path.relpath(p, cwd) if cwd and p.startswith(cwd + "/") else p
        p = "~" + p[len(home):] if p.startswith(home + "/") else p
        return os.path.basename(p) if len(p) > 40 else p  # a long path by its name alone
    prog, args = os.path.basename(words[0]), words[1:]
    plain = [where(a) for a in args if not a.startswith("-")]
    target = plain[-1] if plain else ""
    sub = plain[0] if plain else ""
    if prog == "git":
        if sub == "commit":
            msg = next((args[i + 1] for i, a in enumerate(args[:-1]) if a in ("-m", "-am")), "")
            return f"Committing: {msg.splitlines()[0]}" if msg else "Committing"
        return GIT_VERBS.get(sub, f"Running git {sub}".strip())
    if kind in ("test", "build", "deploy") or sub in ("test", "build") or prog in ("pytest", "jest", "vitest"):
        return run_phrase(kind or ("build" if sub == "build" else "test"), prog, args, where)
    if prog in ("npm", "pnpm", "yarn", "bun") and sub == "run" and len(plain) > 1:
        return f"Running {plain[1]}"
    if prog in ("ls", "tree"):
        return f"Listing {target or 'files'}"
    if prog in ("find", "fd"):
        return f"Finding files in {sub or '.'}"
    if prog == "sed" and "-i" in args:
        return f"Editing {target}"
    if prog in ("cat", "tee") and (">" in step or prog == "tee"):  # cat > file <<EOF
        return f"Writing {where(step.split('>')[-1].split()[0]) if '>' in step else target}"
    if prog == "sleep":
        return f"Waiting {sub}s" if sub.isdigit() else "Waiting"
    if prog in ("cat", "head", "tail", "less", "sed", "wc", "jq", "awk"):
        return f"Reading {target}" if target else f"Running {prog}"
    if prog in ("grep", "rg", "ag"):
        return f"Searching for {sub}" + (f" in {target}" if len(plain) > 1 else "")
    verbs = {"mkdir": "Creating", "rm": "Removing", "rmdir": "Removing", "mv": "Moving", "cp": "Copying",
             "touch": "Creating", "chmod": "Changing permissions of", "open": "Opening"}
    if prog in verbs:
        return f"{verbs[prog]} {target}".strip()
    if prog in ("curl", "wget"):
        url = next((a for a in args if "://" in a), "")
        return f"Fetching {urllib.parse.urlparse(url).netloc or url}".strip()
    if prog.startswith(("python", "node", "bun", "deno", "ruby", "perl")):
        if not plain or "-c" in args or "-e" in args or "-" in args or "<<" in step:
            return f"Running a {prog.rstrip('0123456789.').capitalize()} script"
        return f"Running {sub}"
    return f"Running {prog}"


def tool_summary(name, args, cwd=""):
    """A tool call as a phrase a person reads: a command's own description (Claude writes one
    for nearly every Bash call), else what the call works on, behind a verb."""
    if not isinstance(args, dict):
        return name
    pick = lambda *keys: next((str(args[k]) for k in keys if isinstance(args.get(k), str) and args[k]), "")
    path = pick("file_path", "path", "notebook_path")
    if cwd and path.startswith(cwd + "/"):
        path = os.path.relpath(path, cwd)
    if name == "Bash":
        said = pick("description")
        tagged = re.match(r"(test|build|git|deploy): (.+)", said)  # Steading's "<kind>: <command>"
        if tagged:
            return command_phrase(tagged[2], cwd, tagged[1])
        return said or command_phrase(pick("command"), cwd)
    verbs = {"Read": "Reading", "Write": "Writing", "Edit": "Editing", "MultiEdit": "Editing",
             "NotebookEdit": "Editing"}
    if name in verbs:
        return f"{verbs[name]} {path}"
    if name == "Grep":
        return f"Searching for {pick('pattern')}" + (f" in {path}" if path else "")
    if name == "Glob":
        return f"Finding {pick('pattern')}"
    if name == "WebFetch":
        return f"Reading {urllib.parse.urlparse(pick('url')).netloc or pick('url')}"
    if name == "WebSearch":
        return f"Searching the web: {pick('query')}"
    if name in ("Agent", "Task"):
        return f"Handing off: {pick('description', 'prompt')}"
    if name == "TaskCreate":
        return f"Adding a task: {pick('subject')}"
    if name == "TaskUpdate":
        return f"Task {pick('taskId')}: {pick('status') or 'updated'}"
    if name == "ToolSearch":
        return "Loading tools"
    if name == "Skill":
        return f"Using the {pick('skill', 'name')} skill"
    detail = pick("description", "subagent_type", "pattern", "url", "query", "prompt", "command", "path", "subject")
    return f"{name} {detail}".strip()


class Digest:
    """What a transcript says about its agent, gathered one line at a time."""

    def __init__(self):
        self.model = self.effort = self.requested = ""
        self.thinking_ms = 0
        self.usage = {"in": 0, "cache": 0, "out": 0}
        self.context = 0                       # input tokens of the latest request
        self.outputs = []                      # (time, output tokens) per reply, the last few minutes
        self.seen_messages = set()
        self.open, self.last_tool = {}, None   # tool calls without a result; the latest call
        self.recent = []                       # [id, phrase, started, "" | "ok" | "error"] per call, oldest first
        self.called = set()                    # every tool call id it made (its jobs are among them)
        self.says = ""
        self.tasks, self.task_seq = {}, 0      # TaskCreate / TaskUpdate (TodoWrite too)
        self.first = self.last = None
        self.kinds = {}
        self.report = self.prompt = self.request = ""
        self.request_at = None                 # when the latest request came: the main agent's turn
        self.cwd = ""
        self.task_calls = {}                   # TaskCreate call id -> the task id it was given
        self.task_log = {}                     # task id -> [[time, what, who, text]], its story in the talk
        self.task_waiting = []                 # events waiting for the next thing Claude says
        self.results = {}                      # tool call id -> failed?, for the calls it got answers to

    def task_id_from(self, block):
        """A TaskCreate's result names the id the task got ("Task #4 created"): the list
        restarts with each process, so the order of calls alone can be wrong."""
        tid = self.task_calls.pop(block.get("tool_use_id"), None)
        content = block.get("content")
        text = content if isinstance(content, str) else " ".join(
            c.get("text", "") for c in content or [] if isinstance(c, dict))
        found = re.search(r"Task #(\d+)", text or "")
        if tid is None or not found or found.group(1) == tid:
            return
        real = found.group(1)
        if real in self.tasks:  # an older list's task with the same number: kept apart
            self.tasks[f"{real}·{tid}"] = self.tasks.pop(real)
            self.task_log[f"{real}·{tid}"] = self.task_log.pop(real, [])
        self.tasks[real] = self.tasks.pop(tid)
        self.task_log[real] = self.task_log.pop(tid, [])
        for event in self.task_waiting:
            if event[4] == tid:
                event[4] = real

    def task_words(self, text):
        """What Claude says: the reply each waiting task event was waiting for, and a
        mention for any task named in it."""
        for when, what, who, _, tid in self.task_waiting:
            if tid in self.task_log:
                self.task_log[tid].append([when, what, who, text])
        self.task_waiting = []
        for tid, (subject, _) in self.tasks.items():
            log = self.task_log.setdefault(tid, [])
            if len(subject) >= 6 and subject in text and not (log and log[-1][3] == text):
                log.append([self.last, "mentioned", "Claude", text])
            del log[:-30]  # the latest of a long story

    def feed(self, row):
        try:
            t = datetime_epoch(row["timestamp"])
            self.first, self.last = self.first or t, t
        except (KeyError, TypeError, ValueError):
            pass
        self.cwd = row.get("cwd") or self.cwd
        self.effort = row.get("effort") or self.effort
        self.requested = row.get("requestedModel") or self.requested
        self.thinking_ms = row.get("thinkingDurationMs") or self.thinking_ms
        msg = row.get("message") if isinstance(row.get("message"), dict) else {}
        content = msg.get("content")
        if row.get("type") == "user":
            if isinstance(content, str) and not row.get("isMeta") and content.strip() \
                    and not content.lstrip().startswith("<"):
                self.prompt = self.prompt or content.strip()
                self.request, self.request_at = content.strip(), self.last
            for b in content if isinstance(content, list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    self.open.pop(b.get("tool_use_id"), None)
                    for call in self.recent:
                        if call[0] == b.get("tool_use_id"):
                            call[3] = "error" if b.get("is_error") else "ok"
                    self.results[b.get("tool_use_id")] = bool(b.get("is_error"))
                    self.task_id_from(b)
            return
        if row.get("type") != "assistant":
            return
        self.model = msg.get("model") or self.model
        usage = msg.get("usage") or {}
        if usage and msg.get("id") not in self.seen_messages:  # one turn repeats its usage on each block
            self.seen_messages.add(msg.get("id"))
            self.usage["in"] += usage.get("input_tokens", 0)
            self.usage["cache"] += usage.get("cache_read_input_tokens", 0) + usage.get("cache_creation_input_tokens", 0)
            self.usage["out"] += usage.get("output_tokens", 0)
            if self.last:
                self.outputs = [o for o in self.outputs if o[0] > self.last - 300] + [(self.last, usage.get("output_tokens", 0))]
            self.context = usage.get("input_tokens", 0) + usage.get("cache_read_input_tokens", 0) \
                + usage.get("cache_creation_input_tokens", 0)
        for b in content if isinstance(content, list) else []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and b.get("text", "").strip():
                self.says = b["text"].strip()
                self.task_words(self.says)
            if b.get("type") != "tool_use":
                continue
            name, args = b.get("name", ""), b.get("input") or {}
            if name == "SubagentHandback":
                self.report = str(args.get("report") or args.get("text") or args.get("content") or "")
                continue
            what = " ".join(tool_summary(name, args, self.cwd).split())  # one line, heredocs too
            self.open[b.get("id")] = (name, what, self.last)
            self.called.add(b.get("id"))
            self.last_tool = (name, what, self.last)
            self.recent = self.recent[-500:] + [[b.get("id"), what, self.last, ""]]  # all it did, bounded
            kind = TOOL_KINDS.get(name, "other")
            self.kinds[kind] = self.kinds.get(kind, 0) + 1
            if name == "TaskCreate":
                self.task_seq += 1
                tid = str(self.task_seq)  # until its result says the id it was given
                self.tasks[tid] = [args.get("subject", ""), "pending"]
                self.task_calls[b.get("id")] = tid
                self.task_log[tid] = [[self.last, "created", "you", self.request]]
                self.task_waiting.append([self.last, "created", "Claude", "", tid])  # what Claude says next
            elif name == "TaskUpdate" and str(args.get("taskId")) in self.tasks:
                tid = str(args["taskId"])
                if args.get("status") == "deleted":
                    self.tasks.pop(tid)
                    self.task_log.pop(tid, None)
                elif args.get("status") and args["status"] != self.tasks[tid][1]:
                    self.tasks[tid][1] = args["status"]
                    what = {"in_progress": "started", "completed": "done"}.get(args["status"], args["status"])
                    self.task_waiting.append([self.last, what, "Claude", "", tid])
            elif name == "TodoWrite" and isinstance(args.get("todos"), list):
                self.tasks = {str(i): [t.get("content", ""), t.get("status", "pending")]
                              for i, t in enumerate(args["todos"]) if isinstance(t, dict)}


def wrap_cells(text, width):
    """Wrap text to width terminal cells (wide characters count two), at spaces where it can."""
    lines, line = [], ""
    for word in text.split(" "):
        while cells(word) > width:  # a word longer than a line: break it
            room = width - cells(line) - (1 if line else 0)
            if room <= 0:
                lines.append(line)
                line, room = "", width
            head = ""
            for ch in word:
                if cells(head + ch) > room:
                    break
                head += ch
            lines.append((line + " " if line else "") + head)
            line, word = "", word[len(head):]
        if cells(line) + cells(word) + (1 if line else 0) > width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}" if line else word
    return [l for l in lines + [line] if l] or [""]


def rate(d):
    """Output tokens per minute over the last minute, as "↑ 1.2k tok/min", or ""."""
    per_min = sum(n for t, n in d.outputs if t > time.time() - 60)
    return f"{fg(GREEN_RGB)}↑{RESET}{fg(MUTED_RGB)} {tokens(per_min)} tok/min{RESET}" if per_min else ""


def tokens(n):
    return f"{n / 1_000_000:.1f}M" if n >= 1_000_000 else f"{n / 1000:.0f}k" if n >= 1000 else str(n)


def bar(parts, width):
    """A stacked bar: [(count, rgb)] scaled to width cells."""
    total = sum(n for n, _ in parts) or 1
    out, used = "", 0
    for i, (n, rgb) in enumerate(parts):
        cells_ = round(n * width / total) if i < len(parts) - 1 else width - used
        cells_ = max(1 if n else 0, min(cells_, width - used))
        out += f"{fg(rgb)}{'█' * cells_}"
        used += cells_
    return out + f"{fg(TAB_RGB)}{'░' * (width - used)}{RESET}"


ACTIVITY_FOLD = re.compile(r"▾ \d+ more|▴ fewer")


def button(text, rgb, focused):
    """A control in an agent's detail: a key on a grey cap, lit in its colour while the cursor is on it."""
    if focused:
        return f"{bg(rgb)}{fg(STRIP_RGB)}{BOLD} {text} \033[22m{RESET}"
    return f"{bg(TAB_RGB)}{fg(rgb)} {text} {RESET}"


def card(title, lines, cols):
    """lines in a rounded box cols wide, title in its top border; each line cut or padded to fit."""
    inner = max(4, cols - 4)
    edge = fg("70;76;88")
    head = f" {title} "
    out = [f"{edge}╭─{fg(MUTED_RGB)}{head}{edge}{'─' * max(0, inner - cells(head))}─╮{RESET}"]
    for line in lines:
        line = fit(line, inner)
        out.append(f"{edge}│{RESET} {line}{RESET}{' ' * max(0, inner - cells(ANSI.sub('', line)))} {edge}│{RESET}")
    return out + [f"{edge}╰{'─' * (inner + 2)}╯{RESET}"]


JOB_IDS = {}  # a job's id file: its tool call id (bin/hook writes it once)
ACTIVITY_SHOWN = 5  # calls in the activity card before "▾ N more"


def context_use(d):
    """(percent of the window used, the window) for a digest. A 1M-window model says so
    in its name, or has already gone past the usual limit."""
    limit = 1_000_000 if "[1m]" in (d.requested or "") or d.context > CONTEXT_LIMIT else CONTEXT_LIMIT
    return (min(100, d.context * 100 // limit) if d.context else 0), limit


def dashboard(d, cols, main, title="", links=None, focus=None, window=None, task_rows=None):
    """Everything known about an agent, in cards: what it is (session or task), model
    and usage, what it is doing and did (activity), and tasks. A card with nothing is left out."""
    w = max(16, cols - 4)  # inside a card
    wrap = lambda text, n=w: wrap_cells(" ".join(str(text).split()), n)
    row = lambda label, value: f"{fg(MUTED_RGB)}{label:<8}{RESET}{value}"
    out = []
    # What it is: the session's title (herdr's pane label), or the task a subagent was given.
    if title:
        out += card("session" if main else "task", [f"{BOLD}{part}{RESET}" for part in wrap(title)], cols)
    # model · effort · thinking, context, tokens, tools
    model = (d.model or d.requested or "?").replace("claude-", "")
    chips = [f"{bg(TAB_RGB)}{fg(BRIGHT_RGB)} {model} {RESET}"]
    if d.effort:
        chips.append(f"{bg(TAB_RGB)}{fg(AMBER_RGB)} {d.effort} {RESET}")
    if d.thinking_ms >= 100:
        chips.append(f"{fg(MUTED_RGB)}✻ thought {d.thinking_ms / 1000:.1f}s{RESET}")
    usage = [" ".join(chips)]
    pct, limit = context_use(d)
    rgb = GREEN_RGB if pct < 60 else AMBER_RGB if pct < 85 else RED_RGB
    gauge = max(4, min(24, w - 8 - 16))
    usage.append(row("context", f"{bar([(pct, rgb), (100 - pct, TAB_RGB)], gauge)} {fg(rgb)}{pct}%{RESET}"
                                f"{fg(MUTED_RGB)} {tokens(d.context)}/{tokens(limit)}{RESET}"))
    usage.append(row("tokens", f"{fg(MUTED_RGB)}in{RESET} {tokens(d.usage['in'])}  {fg(MUTED_RGB)}cache{RESET} "
                               f"{tokens(d.usage['cache'])}  {fg(MUTED_RGB)}out{RESET} {tokens(d.usage['out'])}"))
    if d.kinds:
        kinds = sorted(d.kinds.items(), key=lambda kv: -kv[1])
        usage.append(row("tools", bar([(n, KIND_RGB[k]) for k, n in kinds], max(4, min(24, w - 8)))))
        # The legend wraps item by item rather than being cut.
        line, used = "", 0
        for k, n in kinds:
            item, size = f"{fg(KIND_RGB[k])}■{RESET} {k} {n}", len(f"■ {k} {n}")
            if used and used + 2 + size > w - 8:
                usage.append(row("", line))
                line, used = "", 0
            line, used = (f"{line}  {item}", used + 2 + size) if used else (item, size)
        if used:
            usage.append(row("", line))
    out += card("model", usage, cols)
    # Activity: what it did, newest first: the last few, or unfolded a window ({top, at, rows}) on all of it, the cursor's call lit. Long
    # phrases wrap in full rather than being cut.
    # A call that ran long has a button to its output in the jobs tab.
    links = links or {}
    activity = []
    calls = list(reversed(d.recent))

    def rows_of(n):
        """Call n's rows: its mark, the phrase wrapped in full, time and job button on the first row."""
        call_id, phrase, started, state = calls[n]
        path = links.get(call_id)
        link = f"↗ jobs #{os.path.basename(path)}" if path else ""
        right = f"{took(time.time() - started)}" if not state and started else ""
        room = w - 2 - (len(link) + 3 if link else 0) - (len(right) + 1 if right else 0)
        mark = f"{fg(AMBER_RGB)}{spinner()}" if not state else f"{fg(GREEN_RGB)}✓" if state == "ok" else f"{fg(RED_RGB)}✗"
        ink = BRIGHT_RGB if not state or window else MUTED_RGB  # unfolded, done calls read bright too
        tail = (f"{fg(MUTED_RGB)}{right}{RESET} " if right else "") + (button(link, ACCENT["jobs"], focus == path) if link else "")
        out = []
        for i, part in enumerate(wrap(phrase, max(4, room))):
            if i == 0:
                pad = w - 2 - cells(part) - visible_len(tail)
                out.append(f"{mark}{RESET} {fg(ink)}{part}{RESET}{' ' * max(1 if tail else 0, pad)}{tail}")
            else:
                out.append(f"  {fg(ink)}{part}{RESET}")
        if window and n == window["at"]:
            out = [bg(ACTIVE_RGB) + l.replace(RESET, RESET + bg(ACTIVE_RGB)) + " " * max(0, w - visible_len(l)) + RESET
                   for l in out]
        return out

    if window:  # rows to fill: from top, keeping the cursor's call in, none left empty
        at, budget = window["at"], window["rows"]
        top = min(window["top"], at)
        size = {}
        rows = lambda n: size.setdefault(n, len(rows_of(n)))
        while top < at and sum(rows(n) for n in range(top, at + 1)) > budget:
            top += 1
        used, last = rows(top), top
        while last + 1 < len(calls) and used + rows(last + 1) <= budget:
            last += 1
            used += rows(last)
        while top > 0 and used + rows(top - 1) <= budget:
            top -= 1
            used += rows(top)
        window["top"], shown = top, range(top, last + 1)
    else:
        shown = range(min(ACTIVITY_SHOWN, len(calls)))
    for n in shown:
        activity += rows_of(n)
    if len(calls) > ACTIVITY_SHOWN:  # enter or a click there unfolds or folds it
        more = len(calls) - ACTIVITY_SHOWN
        if window:  # where the window is, after the fold
            where = f"{fg(MUTED_RGB)}  {shown[0] + 1}–{shown[-1] + 1} of {len(calls)}{RESET}"
            activity.append(button("▴ fewer", ACCENT["agents"], False) + where)
        else:
            activity.append(button(f"▾ {more} more", ACCENT["agents"], focus == "activity-fold"))
    if activity:
        out += card("activity", activity, cols)
    # tasks
    if d.tasks:
        done = sum(1 for _, st in d.tasks.values() if st == "completed")
        items, todo = list(d.tasks.items()), []
        # A long list keeps what is left in full; the done ones fold into a count.
        if len(items) > 8 and done:
            todo.append(f"{fg(GREEN_RGB)}✓{RESET} {fg(MUTED_RGB)}{done} done{RESET}")
            items = [t for t in items if t[1][1] != "completed"]
        for tid, (subject, st) in items:
            mark = {"completed": f"{fg(GREEN_RGB)}✓", "in_progress": f"{fg(AMBER_RGB)}◐"}.get(st, f"{fg(MUTED_RGB)}○")
            lit = focus == f"task:{tid}"  # enter opens its story
            if task_rows is not None:  # the row it starts on, inside the card (after its top border)
                task_rows.append((len(out) + 1 + len(todo), tid))
            for n, part in enumerate(wrap(subject, w - 2)):  # wrapped under itself, not cut
                line = f"{mark if n == 0 else ' '}{RESET} {part}"
                todo.append(bg(ACTIVE_RGB) + line.replace(RESET, RESET + bg(ACTIVE_RGB)) + " " * max(0, w - visible_len(line)) + RESET
                            if lit else line)
        out += card(f"tasks {done}/{len(d.tasks)}", todo, cols)
    return out


RESUME_SECS = 10  # a subagent writing this long after its "done" notification has been resumed
TEAM_SHOWN = 8  # subagents in an agent's team card, newest first


def team_card(team, cols):
    """The subagents an agent started (a manager's workers, the main agent's subagents),
    newest first: at work or done, what each was given, its model and time."""
    if not team:
        return []
    w = max(16, cols - 4)
    rows, shown = [], team[:TEAM_SHOWN]
    models = [k.top_right() for k in shown]
    times = [k.state()[3] for k in shown]
    mw, tw = max(map(len, models)), max(map(len, times))
    for k, model, when in zip(shown, models, times):
        icon, rgb = k.status()
        right = f"{model:<{mw}}  {when:>{tw}}".strip()  # model and time in columns
        text = cut(k.full, max(4, w - 2 - len(right) - 2))
        rows.append(f"{fg(rgb)}{icon}{RESET} {text}{' ' * max(2, w - 2 - cells(text) - len(right))}{fg(MUTED_RGB)}{right}{RESET}")
    if len(team) > TEAM_SHOWN:
        rows.append(f"{fg(MUTED_RGB)}  {len(team) - TEAM_SHOWN} more{RESET}")
    working = sum(1 for k in team if k.status()[1] == AMBER_RGB)
    return card(f"team {working}/{len(team)} at work", rows, cols)


TASK_STATES = {"completed": ("✓", GREEN_RGB, "done"), "in_progress": ("◐", AMBER_RGB, "in progress")}


def task_story(d, tid, cols):
    """One task's story in the talk, oldest first: when it was made and the request it came
    from, what Claude said as it started and finished it, and where Claude named it."""
    subject, st = d.tasks[tid]
    icon, rgb, state = TASK_STATES.get(st, ("○", MUTED_RGB, "pending"))
    w = max(16, cols - 4)
    lines, said = [], None
    for when, what, who, text in d.task_log.get(tid, []):
        # Its own lines kept (lists, paragraphs), markdown marks left out.
        text = "\n".join(" ".join(l.split()) for l in re.sub(r"[*_`#>]+", "", text or "").splitlines() if l.strip())
        stamp = time.strftime("%H:%M", time.localtime(when)) if when else "     "
        lines.append(f"{fg(MUTED_RGB)}{stamp}{RESET}  {fg(BRIGHT_RGB)}{BOLD}{what}\033[22m{RESET}")
        if not text or text == said:  # the same words as the step before: said once
            continue
        said = text
        whose = f"{fg(ACCENT['agents'] if who == 'Claude' else AMBER_RGB)}{who}{RESET}  "
        text = text[:1200] + ("…" if len(text) > 1200 else "")
        parts = [p for l in text.splitlines() for p in wrap_cells(l, w - 2 - len(who) - 2)]
        lines += [("  " + whose if n == 0 else " " * (len(who) + 4)) + part for n, part in enumerate(parts)]
    if not lines:
        lines.append(f"{fg(MUTED_RGB)}nothing said about it yet{RESET}")
    head = [f"{fg(rgb)}{icon}{RESET} {BOLD}{part}\033[22m" for part in wrap_cells(subject, w - 2)]
    return card(f"← task · {state}", head + [""] + lines, cols)


class AgentRun(Run):
    """One subagent: its row (description, type, state) and its head. No log."""

    def __init__(self, path, deck):
        self.path, self.deck = path, deck   # the agent's transcript; the Agents view
        self.id = os.path.basename(path)[len("agent-"):-len(".jsonl")]
        try:
            with open(path[:-len(".jsonl")] + ".meta.json") as f:
                self.meta = json.load(f)
        except (OSError, ValueError):
            self.meta = {}
        self.tag, self.is_git = "", False
        self.full = self.cmd = self.meta.get("description") or self.id
        self.first, self.calls, self.read_to, self.stamps, self.cols = os.path.getmtime(path), 0, 0, [], 60
        self.digest = Digest()
        self.count()

    def count(self):
        """Feed the transcript's new lines to the digest (its file only grows)."""
        try:
            with open(self.path, "rb") as f:
                f.seek(self.read_to)
                data = f.read()
        except OSError:
            return
        done = data.rfind(b"\n") + 1
        for raw in data[:done].splitlines():
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            self.digest.feed(row)
            if self.digest.last and (not self.stamps or self.stamps[-1] != self.digest.last):
                self.stamps.append(self.digest.last)
        self.read_to += done
        self.first = self.digest.first or self.first
        self.calls = sum(self.digest.kinds.values())

    def parent(self):
        """The subagent that started this one (a subagent's subagent), or None."""
        pid = self.meta.get("parentAgentId")
        return next((r for r in self.deck.every if r.id == pid), None) if pid else None

    def ended(self):
        """"done", "failed" or "stopped" once the transcript that called it says so
        (the main one, or its parent subagent's), else ""."""
        if self.meta.get("requestShape") != "background":
            parent = self.parent()
            answers = parent.digest.results if parent else self.deck.results
            hit = answers.get(self.meta.get("toolUseId", ""))
            if hit is not None:
                return "failed" if hit else "done"
        end = self.deck.notified.get(self.id, "")
        # A background subagent can be sent a message after it finished: it works again,
        # writing its transcript after the notification that said it was done.
        if end and os.path.exists(self.path) and \
                os.path.getmtime(self.path) > getattr(self.deck, "notified_at", {}).get(self.id, 0) + RESUME_SECS:
            return ""
        return end

    def status(self):
        end = self.ended()
        if end:
            return {"done": ("✓", GREEN_RGB), "failed": ("✗", RED_RGB)}.get(end, ("⊘", MUTED_RGB))
        try:
            quiet = time.time() - os.path.getmtime(self.path)
        except OSError:
            quiet = LIVE_SECS
        return (spinner(), AMBER_RGB) if quiet < LIVE_SECS else ("·", MUTED_RGB)

    def rc(self):
        return {"done": "0", "failed": "1"}.get(self.ended(), "")

    def source(self):
        return ""

    def end(self):
        return ""

    def hash(self):
        return ""

    def label(self):
        return getattr(self, "tree_prefix", "  " * int(self.meta.get("spawnDepth") or 1)) + self.full  # under the main agent

    def subline(self):
        """The row under its name in the list: what it is doing (the call running, else
        its latest words, else its last call), then its tasks done (when it keeps a list)
        and how long it has been at it, as (text, plain, shown)."""
        self.count()
        d = self.digest
        if isinstance(self, MainRun) and self.deck.agent_status == "blocked":
            doing = "waiting for you"
        elif d.open or (d.last_tool and not d.says):
            name, what, _ = list(d.open.values())[-1] if d.open else d.last_tool
            doing = what.splitlines()[0] if what else name
        else:
            # Its first line of words, without markdown marks.
            lines = [re.sub(r"[*_`#>]+", "", l).strip() for l in (d.says or "").splitlines()]
            doing = next((l for l in lines if l), "")
        indent = getattr(self, "tree_cont", None) or " " * (len(self.label()) - len(self.label().lstrip(" ")) + 2)
        plain = shown = ""
        if d.tasks:
            done, total = sum(1 for _, st in d.tasks.values() if st == "completed"), len(d.tasks)
            filled = round(5 * done / total)
            plain = f"{'▰' * filled}{'▱' * (5 - filled)} {done}/{total}  "
            shown = f"{fg(GREEN_RGB)}{'▰' * filled}{fg(DIMMED_RGB)}{'▱' * (5 - filled)} {fg(MUTED_RGB)}{done}/{total}  "
        age = self.age()
        return indent + doing, plain + age, shown + f"{fg(MUTED_RGB)}{age}"

    def top_right(self):
        """Its model, at the right of its first row in the list."""
        self.count()
        return re.sub(r"-\d{8}$", "", (self.digest.model or self.digest.requested or "").replace("claude-", ""))

    def age(self):
        """How long it has been at work (the list shows only those at work)."""
        return took(time.time() - (self.digest.first or self.first))

    def info(self):
        self.count()
        parts = [self.meta.get("agentType") or "agent", f"{self.calls} tool call{'s' * (self.calls != 1)}"]
        if self.meta.get("requestShape") == "background":
            parts.insert(1, "background")
        return f"{DIM}  {' · '.join(parts)}{RESET}"

    def command(self, cols):
        return [f"{BOLD}{line}{RESET}" for line in textwrap.wrap(self.full, max(10, cols))[:2]]

    def state(self):
        """(name, colour, icon, how long) for the status pill."""
        icon, colour = self.status()
        end = self.ended()
        stamps = self.stamps or [self.first]
        if end:
            return end, colour, icon, f"after {took(stamps[-1] - stamps[0])}"
        if colour == AMBER_RGB:
            return "running", colour, icon, f"for {took(time.time() - stamps[0])}"
        return "idle", MUTED_RGB, icon, ""

    def job_links(self):
        """{tool call id: run path} for its calls the jobs tab lists (the ones that ran long),
        so the activity card can lead to their output."""
        links = {}
        for idfile in glob.glob(os.path.join(BASE, "jobs", "runs", "*", "id")):
            call = JOB_IDS.get(idfile) or JOB_IDS.setdefault(idfile, read(idfile))  # written once, with the job
            if call in self.digest.called and Jobs.shows(os.path.dirname(idfile)):
                links[call] = os.path.dirname(idfile)
        return links

    def lines(self):
        self.count()
        name, colour, icon, since = self.state()
        since = "  ".join(x for x in (since, rate(self.digest)) if x)
        focus = getattr(self, "focus_key", None)  # the control the cursor is on (Agents sets it)
        links = self.job_links()
        # Found again by "↗ jobs #n": its rows are redrawn (spinner, time) between frames.
        self.job_rows = {f"↗ jobs #{os.path.basename(path)}": path for path in links.values()}
        self.links = links
        window = None
        if getattr(self, "activity_open", False):  # the window keeps the activity cursor in it
            total = len(self.digest.recent)
            at = max(0, min(getattr(self, "activity_at", 0), total - 1))
            window = {"top": max(0, getattr(self, "activity_top", 0)), "at": at,
                      "rows": getattr(self, "activity_rows", 10)}  # rows of the card, not calls: they wrap
        if getattr(self, "task_open", None) in self.digest.tasks:  # one task's story, in place of the cards
            self.controls = []
            return task_story(self.digest, self.task_open, self.cols)
        self.task_open = None
        head = status_block(name, colour, icon, since, self.stamps, self.cols) + team_card(getattr(self, "team", []), self.cols)
        task_rows = []
        title = self.label().strip() if isinstance(self, MainRun) else self.full
        out = head + dashboard(self.digest, self.cols, isinstance(self, MainRun), title,
                               links, focus, window, task_rows)
        if window:  # the top the card settled on, the cursor's call in view
            self.activity_at, self.activity_top = window["at"], window["top"]
        # Its controls, in order, with the row each is on: the keyboard moves between these.
        self.controls = []
        for n, line in enumerate(out):
            text = ANSI.sub("", line)
            job = next((p for link, p in self.job_rows.items() if link in text), None)
            if job:
                self.controls.append((job, n))
            elif ACTIVITY_FOLD.search(text):
                self.controls.append(("activity-fold", n))
                if window:  # where the unfolded card starts and ends: the view holds all of it
                    self.activity_span = (next(i for i in range(n, -1, -1) if "╭─ activity " in ANSI.sub("", out[i])), n + 1)
        self.controls += [(f"task:{tid}", len(head) + row) for row, tid in task_rows]
        self.controls.sort(key=lambda c: c[1])
        return out

    def activity_job(self):
        """The job (its run path) of the call under the activity cursor, if it ran long."""
        calls = list(reversed(self.digest.recent))
        at = getattr(self, "activity_at", 0)
        return getattr(self, "links", {}).get(calls[at][0]) if 0 <= at < len(calls) else None

    def press(self, key):
        """enter on the control key: a job goes to its output in the jobs tab; the fold shows
        everything the agent did, or the last few again."""
        if key == "activity-fold":
            self.activity_open = not getattr(self, "activity_open", False)
        elif key.startswith("task:"):  # its story, until esc
            self.task_open = key[len("task:"):]
        elif getattr(self.deck, "jump", None):
            self.deck.jump("jobs", key)

    def activate(self, line):
        """A click on a job's button goes to its output in the jobs tab; on the fold, all or fewer."""
        if ACTIVITY_FOLD.search(line):
            self.press("activity-fold")
            return True
        job = next((p for link, p in getattr(self, "job_rows", {}).items() if link in line), None)
        if job and getattr(self.deck, "jump", None):
            self.deck.jump("jobs", job)
            return True
        return False

    def plain(self):
        return [ANSI.sub("", l) for l in self.lines()]


class MainRun(AgentRun):
    """The agent itself, on top of the list: its session's title and herdr's state for it."""

    def __init__(self, path, deck):
        self.path, self.deck, self.id, self.meta = path, deck, "main", {}
        self.tag, self.is_git = "", False
        self.first, self.calls, self.read_to, self.stamps, self.cols = os.path.getmtime(path), 0, 0, [], 60
        self.full = self.cmd = "main agent"

    def count(self):  # read with the main transcript (Agents.read_main)
        self.stamps, self.digest = self.deck.stamps, self.deck.digest

    def state(self):
        icon, colour = self.status()
        if self.deck.agent_status == "working":
            return "working", colour, icon, ""
        if self.deck.agent_status == "blocked":
            return "waiting for you", RED_RGB, "!", ""
        return self.deck.agent_status or "idle", MUTED_RGB, icon, ""

    def status(self):
        state = self.deck.agent_status
        if state == "working":
            return (spinner(), AMBER_RGB)
        return ("!", AMBER_RGB) if state == "blocked" else ("·", MUTED_RGB)

    def ended(self):
        return ""

    def label(self):
        return self.deck.title or "main agent"

    def age(self):
        """How long the current turn has run: since the latest request, while working."""
        self.count()
        at = self.digest.request_at
        return took(time.time() - at) if at and self.deck.agent_status == "working" else ""


    def info(self):
        at_work = len(self.deck.runs) - 1
        state = self.deck.agent_status or "idle"
        return f"{DIM}  main agent · {state} · {at_work} subagent{'s' * (at_work != 1)} at work{RESET}"

    def command(self, cols):
        return [f"{BOLD}{line}{RESET}" for line in textwrap.wrap(self.label(), max(10, cols))[:2]]


class Agents(Runs):
    """The agent on top, then its Claude Code subagents at work."""

    noun = "agents"

    def __init__(self):
        super().__init__("agents")
        self.session, self.looked = "", 0.0           # the main transcript, found through herdr
        self.title, self.agent_status = "", ""        # the session's title and state, as herdr has them
        self.results, self.notified = {}, {}          # what the main transcript says about subagents
        self.notified_at = {}                         # when each subagent's latest notification came
        self.read_to, self.reading = 0, False
        self.main, self.stamps = None, []             # the main transcript's write times, last hour
        self.digest = Digest()                        # what the main transcript says about the agent

    def find_session(self):
        """The newest transcript of the Claude session herdr runs in the agent's pane."""
        agent = os.path.basename(BASE).replace("_", ":")
        try:
            out = subprocess.run([os.environ.get("HERDR_BIN_PATH", "herdr"), "pane", "get", agent],
                                 capture_output=True, text=True, timeout=3).stdout
            pane = json.loads(out)["result"]["pane"]
        except (OSError, subprocess.SubprocessError, ValueError, KeyError):
            pane = {}
        ref = pane.get("agent_session") or {}
        self.title = pane.get("label") or pane.get("terminal_title_stripped") or ""
        self.agent_status = pane.get("agent_status") or ""
        found = []
        if ref.get("agent") == "claude" and ref.get("value"):
            root = os.path.expanduser("~/.claude/projects")
            try:
                found = [os.path.join(root, d, ref["value"] + ".jsonl") for d in os.listdir(root)]
            except OSError:
                pass
        found = [f for f in found if os.path.isfile(f)]
        session = max(found, key=os.path.getmtime) if found else ""
        if session != self.session:
            self.session, self.results, self.notified, self.read_to, self.stamps = session, {}, {}, 0, []
            self.notified_at = {}
            self.digest = Digest()

    def read_main(self):
        """What the main transcript has said since the last read: answers to Agent calls
        and task notifications (a big transcript is read once, then only its new lines)."""
        try:
            with open(self.session, "rb") as f:
                f.seek(self.read_to)
                data = f.read()
        except OSError:
            data = b""
        done = data.rfind(b"\n") + 1  # leave a half-written last line for next time
        horizon = time.time() - 3600
        for stamp in STAMP.findall(data[:done]):
            try:
                t = datetime_epoch(stamp.decode())
            except ValueError:
                continue
            if t > horizon:
                self.stamps.append(t)
        self.stamps = [t for t in self.stamps if t > horizon]
        for raw in data[:done].splitlines():
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            self.digest.feed(row)
            if b"tool_result" not in raw and b"task-notification" not in raw:
                continue
            content = (row.get("message") or {}).get("content")
            blocks = content if isinstance(content, list) else [{"type": "text", "text": content or ""}]
            # A notification for a busy session waits in the queue first (a top-level
            # "content", type queue-operation) and reaches the messages only later.
            if isinstance(row.get("content"), str):
                blocks.append({"type": "text", "text": row["content"]})
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_result":
                    self.results[b.get("tool_use_id")] = bool(b.get("is_error"))
                text = b.get("text") if b.get("type") == "text" else None
                if isinstance(text, str) and "<task-notification>" in text:
                    try:
                        when = datetime_epoch(row["timestamp"])
                    except (KeyError, TypeError, ValueError):
                        when = time.time()
                    for agent, status in NOTIFICATION.findall(text):
                        self.notified[agent.strip()] = {"completed": "done", "failed": "failed"}.get(
                            status.strip(), "stopped" if status.strip() in ("stopped", "killed") else "")
                        self.notified_at[agent.strip()] = when
        self.read_to += done
        self.reading = False

    def refresh(self):
        if time.time() - self.looked >= 2:
            self.looked = time.time()
            background(self.find_session)
        if self.session and not self.reading:
            self.reading = True
            background(self.read_main)
        folder = self.session[:-len(".jsonl")] + "/subagents" if self.session else ""
        paths = glob.glob(f"{folder}/agent-*.jsonl") + glob.glob(f"{folder}/workflows/*/agent-*.jsonl") if folder else []
        # A subagent's transcript is read in the background the first time (a deck starting
        # beside a long session would otherwise stall on all of them); it joins once read.
        keep = {r.path: r for r in getattr(self, "every", [])}
        missing = [p for p in paths if p not in keep and p not in getattr(self, "built", {})]
        if missing and not getattr(self, "building", False):
            self.building, self.built = True, dict(getattr(self, "built", {}))
            def build(todo=missing):
                for p in todo:
                    self.built[p] = AgentRun(p, self)
                self.building = False
            background(build)
        keep.update(getattr(self, "built", {}))
        self.every = [keep[p] for p in paths if p in keep]
        if self.session and (self.main is None or self.main.path != self.session):
            self.main = MainRun(self.session, self)
        # The subagents at work as a tree: the newest on top, each subagent's own
        # subagents right under it. The list draws the last run on top, so the tree
        # is built top down and turned round, the main agent last.
        # A subagent's own subagents hang off it with branch lines (├ └, │ carrying on past
        # a branch that has more below it), so a manager and its workers read as one group.
        working = [r for r in self.every if r.status()[1] == AMBER_RGB]
        ids = {r.id for r in working}
        def under(pid, lead=""):
            kids = sorted((r for r in working if (r.meta.get("parentAgentId") if r.meta.get("parentAgentId") in ids else None) == pid),
                          key=lambda r: -r.first)
            out = []
            for n, r in enumerate(kids):
                last = n == len(kids) - 1
                if pid is None:  # under the main agent: no branch line
                    r.tree_prefix, r.tree_cont, below = "  ", "    ", ""
                else:
                    r.tree_prefix = "  " + lead + ("└ " if last else "├ ")
                    r.tree_cont = "  " + lead + ("  " if last else "│ ") + "  "
                    below = lead + ("  " if last else "│ ")
                out += [r] + under(r.id, below)
            return out
        runs = under(None)[::-1] + ([self.main] if self.session else [])
        # Each agent's team: the subagents it started, at work or done, for its detail.
        for r in self.every + ([self.main] if self.main else []):
            mine = None if isinstance(r, MainRun) else r.id
            r.team = sorted((k for k in self.every if k.meta.get("parentAgentId") == mine), key=lambda k: -k.first)
        # New: a subagent never seen before. (An ended one can show as at work for a moment
        # until the main transcript is read; coming back is not being new.)
        ever = getattr(self, "ever", None)
        if self.session and getattr(self, "seeded", None) != self.session:
            # What the session already had when the deck found it is not new, read yet or not.
            self.seeded = self.session
            ever = (ever or set()) | set(paths) | {self.session}
        new = ever is not None and any(r.path not in ever for r in runs)
        self.ever = (ever or set()) | {r.path for r in self.every} | {r.path for r in runs}
        picked = self.runs[self.tab].path if self.runs else None
        self.runs = runs
        paths = [r.path for r in runs]
        if new:
            # A new subagent: picked, wherever the tree puts it.
            self.select(paths.index(max((r for r in runs if r.path not in ever), key=lambda r: r.first).path))
            self.fresh = (runs[self.tab], time.time())
        elif self.known is None or picked not in paths:
            self.select(len(runs) - 1)  # the main agent
        else:
            self.tab = paths.index(picked)
        self.known = set(paths)
        return new

    def badge(self):
        if any(r.status()[1] == AMBER_RGB for r in self.runs):
            return (spinner(), AMBER_RGB)
        return ("·", MUTED_RGB)

    # An agent's detail is no log: it reads the same picked or not, and enter moves the
    # keyboard between its controls (its jobs, the fold of its activity) instead. Unfolded,
    # the activity card scrolls on its own, with a cursor of its own, until esc folds it.
    dim_unfocused = copy_cursor = False
    control = 0

    def controls(self):
        return getattr(self.runs[self.tab], "controls", []) if self.runs else []

    def inside(self):
        """The activity card is unfolded and the keyboard is in it."""
        return bool(self.runs) and self.focus == "log" and getattr(self.runs[self.tab], "activity_open", False)

    def frame(self, cols, rows):
        if self.runs:
            run = self.runs[self.tab]
            run.activity_rows = max(3, self.height - 5)  # the card's window: the box, less its said line, borders and fold
            keys = [k for k, _ in self.controls()]
            if getattr(self, "want", None) in keys:  # back on the control that opened what just closed
                self.control = keys.index(self.want)
                self.want = None
            self.control = min(self.control, max(0, len(keys) - 1))
            if self.inside():
                run.focus_key = run.activity_job()
            else:
                run.focus_key = keys[self.control] if self.focus == "log" and keys else None
        return super().frame(cols, rows)

    def place_cursor(self):
        """The detail starts at its top and scrolls only to keep the picked control (or the
        activity cursor) in view."""
        rows = [n for _, n in self.controls()]
        span = getattr(self.runs[self.tab], "activity_span", None) if self.inside() else None
        if span:  # the unfolded card, top to bottom: it scrolls inside, the detail stays put
            self.offset, self.cy = span[0], min(span[1], span[0] + self.height - 1)
        elif self.focus == "log" and rows and not getattr(self, "past", False):
            self.cy = rows[min(self.control, len(rows) - 1)]
        else:  # no control to follow (or j went on past the last one): the scroll stays as set
            self.cy = self.offset

    def select(self, tab):
        super().select(tab)
        self.offset, self.control, self.past = 0, 0, False

    def list_key(self, k):
        if k in ("\r", "\n", "l"):  # into the detail: onto its first control, if it has any
            self.focus, self.control, self.past = "log", 0, False
            return
        super().list_key(k)

    def fold(self):
        self.runs[self.tab].activity_open, self.want = False, "activity-fold"

    def activity_key(self, k):
        """Keys in the unfolded activity card: j/k a row, vim's ctrl+d/u, f/b, e/y, g/G,
        enter to a job's output, esc (or h) folds it. False: not one of these."""
        run = self.runs[self.tab]
        total, rows = len(run.digest.recent), max(1, min(run.activity_rows, len(run.digest.recent)))
        at, top = getattr(run, "activity_at", 0), getattr(run, "activity_top", 0)
        if k in ("j", "k"):
            at += 1 if k == "j" else -1
        elif k in SCROLLS:
            step = SCROLLS[k](rows)
            top = max(0, min(top + step, total - rows))
            at = max(top, min(at, top + rows - 1)) if k in "\x05\x19" else at + step
        elif k in ("g", "G"):
            at = 0 if k == "g" else total - 1
        elif k in ("\r", "\n"):
            if run.activity_job():
                run.press(run.activity_job())
            return True
        elif k in ("\x1b", "h"):
            self.fold()
            return True
        else:
            return False
        run.activity_at, run.activity_top = max(0, min(at, total - 1)), top
        return True

    def story(self):
        """The task whose story the detail shows, if one is open."""
        return getattr(self.runs[self.tab], "task_open", None) if self.runs and self.focus == "log" else None

    def key(self, k):
        if not self.runs or self.focus == "list":
            return super().key(k)
        if self.story():  # a task's story: it scrolls; esc, h or backspace goes back to the task
            if k in ("\x1b", "h", "\x7f", "\x08"):
                self.want = f"task:{self.story()}"
                self.runs[self.tab].task_open, self.offset = None, getattr(self, "story_from", 0)
            elif k in ("j", "k"):
                self.offset = max(0, self.offset + (1 if k == "j" else -1))
            elif k in SCROLLS:
                self.offset = max(0, self.offset + SCROLLS[k](max(1, self.height)))
            elif k in ("g", "G"):
                self.offset = 0 if k == "g" else len(self.plain)
            return
        if self.inside():
            if self.activity_key(k):
                return
            self.fold()  # any other key (tab, ...) leaves the card folded, then does what it does
        count = len(self.controls())
        past = getattr(self, "past", False)
        if k == "k" and past:  # scrolled past the last button (still lit): k goes on up, to the one before
            self.past = False
            self.control = max(0, self.control - 1)
        elif not count and k in ("j", "k"):  # nothing to press: j/k scroll the detail
            self.offset = max(0, self.offset + (1 if k == "j" else -1))
        elif k == "j" and self.control >= count - 1:  # past the last control: scroll on to the end
            self.past = True
            self.offset += 1
        elif k in ("j", "\t"):
            self.control = min(count - 1, self.control + 1)
        elif k in ("k", "\x1b[Z"):
            self.control = max(0, self.control - 1)
        elif k == "h" and self.control == 0 and self.offset == 0:  # h or ← at the top: back to the list
            self.focus = "list"
        elif k in ("\r", "\n") and count:
            key = self.controls()[self.control][0]
            if key.startswith("task:"):  # its story opens at its top; esc comes back here
                self.story_from, self.offset = self.offset, 0
            self.runs[self.tab].press(key)
            if key == "activity-fold" and self.runs[self.tab].activity_open:  # into the card, at its newest
                self.runs[self.tab].activity_at = self.runs[self.tab].activity_top = 0
        elif k == "\x1b":
            self.focus = "list"

    def click(self, row, col):
        """A click on a control presses it; elsewhere in the detail it does nothing."""
        listed = getattr(self, "listed", [])
        if self.runs and 0 <= row - HEAD_ROW - 1 < len(listed):
            self.select(listed[row - HEAD_ROW - 1])
            self.focus = "list"
            return
        line = self.offset + row - getattr(self, "body_row", 99)
        if self.story():  # a task's story: a click on its "← task" border goes back
            if 0 <= line < len(self.plain) and "← task" in self.plain[line]:
                self.key("\x1b")
            return
        for n, (key, at) in enumerate(self.controls()):
            if at == line:
                self.focus, self.control = "log", n
                if key.startswith("task:"):  # its story opens at its top; esc comes back here
                    self.story_from, self.offset = self.offset, 0
                self.runs[self.tab].press(key)
                if key == "activity-fold" and not self.runs[self.tab].activity_open:
                    self.want = key
                return

    def wheel(self, down, row=0):
        if self.runs and HEAD_ROW < row <= HEAD_ROW + len(getattr(self, "listed", [])):
            return super().wheel(down, row)
        if self.inside():  # the unfolded card scrolls, the detail stays
            for _ in range(3):
                self.activity_key("\x05" if down else "\x19")
            return
        self.offset = max(0, self.offset + (3 if down else -3))

    def hints(self):
        if self.story():
            return [("j/k", "scroll"), ("esc/⌫", "back")]
        if self.inside():
            return [("ctrl+d/u", "page"), ("esc", "fold")]
        if self.focus == "log":
            if not self.controls():
                return [("h/esc", "back")]
            return [("enter", "press"), ("h/esc", "back")]
        return [("L", "side"), ("[ ]", "tabs"), (",", "settings"), ("ctrl+c", "close")]


SCROLLS = {"\x04": lambda h: h // 2 or 1, "\x15": lambda h: -(h // 2 or 1), "\x06": lambda h: h, "\x02": lambda h: -h,
           "\x05": lambda h: 1, "\x19": lambda h: -1}


class Deck:
    def __init__(self):
        self.views = [Agents(), Jobs(), Servers()] + [Git() if k == "git" else Runs(k) for k in SECTIONS[3:]]
        self.views[0].jump = self.jump  # a job in an agent's detail leads to the jobs tab
        self.section = 0
        self.unseen = set()  # tabs with something new not shown yet
        self.settings, self.settings_open, self.setting = settings(), False, 0
        self.last_frame = None
        self.focus_path = os.path.join(BASE, "focus")
        # The section last picked by hand in any deck, shared by all of them.
        self.shared_path = os.path.join(os.path.dirname(BASE), "section")
        self.focus_at = self.mtime(self.focus_path)
        self.shared_at = self.mtime(self.shared_path)
        # Open on whichever is newer: the section that asked for this deck, or
        # the one last picked anywhere.
        latest = self.focus_path if self.focus_at > self.shared_at else self.shared_path
        first = read(latest)  # once: another deck may be rewriting it
        if first in SECTIONS:
            self.section = SECTIONS.index(first)

    @staticmethod
    def mtime(path):
        try:
            return os.path.getmtime(path)
        except OSError:
            return 0

    def jump(self, kind, path):
        """Show the run in path in its section, picked in the list."""
        i = SECTIONS.index(kind)
        view = self.views[i]
        view.refresh()
        paths = [r.path for r in view.runs]
        if path in paths:
            view.select(paths.index(path))
            view.focus = "list"
        self.section = i

    def choose(self, i):
        """A section picked by hand: show it here and in every other deck."""
        self.section = i % len(self.views)
        # Written off the loop, so the switch draws at once; one writer, always the latest
        # pick, so fast switching never leaves an older tab in the file for the other decks.
        self.share_want = SECTIONS[self.section]
        if getattr(self, "sharing", False):
            return
        self.sharing = True
        def share():
            try:
                while True:
                    name = self.share_want
                    try:
                        with open(self.shared_path, "w") as f:
                            f.write(name)
                        self.shared_at = self.mtime(self.shared_path)
                    except OSError:
                        pass
                    if self.share_want == name:
                        return
            finally:
                self.sharing = False
        background(share)

    def arrived(self, i):
        """Something new on tab i: the deck goes there when following, else the tab is marked."""
        if self.settings["follow"]:
            self.section = i
        else:
            self.unseen.add(i)

    def popup(self, cols, rows):
        """The settings popup: (first row, its lines, first column) centred in the pane,
        on a raised background."""
        width = max(30, min(cols - 6, 66))
        inner = width - 6
        face = bg("44;49;58")  # the popup's ground: lighter than the deck under it
        edge = f"{face}{fg(ACCENT['agents'])}"
        title = " Settings "
        lines = [f"{edge}╭─{fg(BRIGHT_RGB)}{BOLD}{title}\033[22m{edge}{'─' * (width - 3 - len(title))}╮{RESET}"]
        body = [""]
        for n, (key, label, what, _, choices) in enumerate(SETTINGS):
            on = self.settings[key]
            if choices:  # a value picked from a few: h/l or space step through them
                switch = f"{bg(ACCENT['agents'])}{fg(STRIP_RGB)}{BOLD} ‹{on:>2}s› \033[22m"
            else:
                switch = f"{bg(GREEN_RGB)}{fg(STRIP_RGB)}{BOLD}  ON   \033[22m" if on else f"{bg(ACTIVE_RGB)}{fg(MUTED_RGB)}  OFF  "
            picked = n == self.setting
            mark = f"{fg(ACCENT['agents'])}❯" if picked else " "
            name = f"{BOLD if picked else ''}{fg(BRIGHT_RGB)}{label}\033[22m"
            body.append(f"{mark} {name}{face}{' ' * max(1, inner - 2 - len(label) - 7)}{switch}{RESET}")
            body += [f"  {fg(MUTED_RGB)}{part}" for part in wrap_cells(what, inner - 2)]
            body.append("")
        body.append(f"{fg(DIMMED_RGB)}j/k move · space h/l change · q close")
        body.append("")
        for line in body:
            pad = inner - cells(ANSI.sub("", line))
            lines.append(f"{edge}│{face}  {line.replace(RESET, RESET + face)}{face}{' ' * max(0, pad)}  {edge}│{RESET}")
        lines.append(f"{edge}╰{'─' * (width - 2)}╯{RESET}")
        return max(1, (rows - len(lines)) // 2), lines, (cols - width) // 2

    def look_focus(self):
        """Ask herdr whether this deck's pane has the keyboard (when the terminal
        sends no focus reports)."""
        try:
            out = subprocess.run([os.environ.get("HERDR_BIN_PATH", "herdr"), "pane", "get", read(os.path.join(BASE, "pane"))],
                                 capture_output=True, text=True, timeout=2).stdout
            FOCUS["pane"] = bool(json.loads(out)["result"]["pane"]["focused"])
        except (OSError, subprocess.SubprocessError, ValueError, KeyError):
            pass
        self.looking = False

    def refresh(self):
        # Focus reports arrive at once, when the terminal and herdr pass them on; herdr is
        # asked as well, since focus moved by herdr itself (a key, the API) may send none.
        if not getattr(self, "looking", False) and time.time() - getattr(self, "looked", 0) >= 0.5:
            self.looking, self.looked = True, time.time()
            background(self.look_focus)
        at = self.mtime(SETTINGS_PATH)
        if at != getattr(self, "settings_at", None):  # changed here or in another deck
            self.settings_at, self.settings = at, settings()
        # Something new elsewhere marks its tab, or (following) takes the deck there.
        for i, view in enumerate(self.views):
            if view.refresh() and i != self.section:
                self.arrived(i)
        if not getattr(self, "warmed", False):  # once: every tab's rows read ahead, so a first switch is instant
            self.warmed = True
            background(self.warm)
        at = self.mtime(self.focus_path)
        if at != self.focus_at:  # a section was asked for (e.g. a dev server started)
            self.focus_at = at
            focus = read(self.focus_path)  # once, as above
            if focus in SECTIONS and SECTIONS.index(focus) != self.section:
                self.arrived(SECTIONS.index(focus))
        at = self.mtime(self.shared_path)
        if at != self.shared_at:  # picked by hand in another deck
            self.shared_at = at
            shared = read(self.shared_path)  # once: another deck may be rewriting it
            if shared in SECTIONS:
                self.section = SECTIONS.index(shared)

    def warm(self):
        """Read what each tab's rows show (status, age, label, info) in the background,
        filling the runs' kept files, so the first switch to a tab draws at once."""
        for idfile in glob.glob(os.path.join(BASE, "jobs", "runs", "*", "id")):  # the agents' job buttons
            JOB_IDS.setdefault(idfile, read(idfile))
            Jobs.shows(os.path.dirname(idfile))
        for view in self.views:
            for run in list(view.runs):
                try:
                    run.status(), run.label()
                    getattr(run, "age", lambda: "")()
                    getattr(run, "info", lambda: "")()
                except Exception:  # a run half written or gone: its tab reads it when shown
                    pass

    NEW_RGB = blend(RED_RGB, TAB_RGB, 0.35)  # a tab with something new, until it is shown: red-tinted

    def section_bar(self, cols):
        self.unseen.discard(self.section)  # on show: seen
        cells = []
        for i, view in enumerate(self.views):
            icon, colour = view.badge()
            name = view.kind.upper()
            # No number on the tab (1-7 still jump there): more fit a narrow pane.
            # Its key letter underlined: shift and that letter (A, J, S, ...) goes there.
            at = name.index(TAB_KEYS[i])
            name = f"{name[:at]}\033[4m{name[at]}\033[24m{name[at + 1:]}"
            if i == self.section and not FOCUS["pane"]:  # shown, but the keyboard is elsewhere: grey
                text = f"{bg(ACTIVE_RGB)}{fg(BRIGHT_RGB)}{BOLD} {name} {icon} \033[22m"
            elif i == self.section:
                text = f"{bg(ACCENT[view.kind])}{fg(STRIP_RGB)}{BOLD} {name} {icon} \033[22m"
            elif i in self.unseen:
                text = f"{bg(self.NEW_RGB)}{fg(BRIGHT_RGB)}{BOLD} {name} {icon} \033[22m"
            else:
                text = f"{bg(TAB_RGB)}{fg(MUTED_RGB)} {name} {fg(colour)}{icon} "
            cells.append((len(view.kind) + 4, text))
        # The strip starts with ✕: a click there closes the deck, as ctrl+c does.
        bar, spans = strip(cells, cols - CLOSE_W, self.section, self.unseen, self.NEW_RGB)
        self.spans = [(i, x0 + CLOSE_W, x1 + CLOSE_W) for i, x0, x1 in spans]
        return f"{bg(STRIP_RGB)}{fg(RED_RGB)}{BOLD} ✕ \033[22m" + bar

    def draw(self):
        cols, rows = shutil.get_terminal_size()
        cols -= 1  # herdr's pane scrollbar covers the last column
        view = self.views[self.section]
        head, body = view.frame(cols, rows - 1)  # the last row holds the key hints
        # Overwrite in place (each line clears its own tail, \033[J the rest)
        # instead of clearing the screen, so nothing flashes between frames.
        bar, lines = self.section_bar(cols), (head + body)[:rows - 2]
        if self.settings_open:  # the popup over the deck, the deck faint around it
            # The deck behind it loses its colours: one dark grey, so the popup stands out.
            lines = [f"{fg('58;62;70')}{ANSI.sub('', line)}" for line in lines] + [""] * max(0, rows - 2 - len(lines))
            first, box, left = self.popup(cols, rows - 2)
            for n, line in enumerate(box):
                if 0 <= first + n < len(lines):
                    lines[first + n] = " " * left + line
        if not FOCUS["pane"]:  # without the keyboard the whole deck reads faint, its colours kept
            bar, lines = tint(bar, DIMMED_RGB), [tint(line, DIMMED_RGB) for line in lines]
        out = [bar, "\033[K"]
        # Never past the hints row: a taller frame would scroll the tabs off the top.
        for line in lines:
            out += ["\r\n", fit(line, cols), RESET, "\033[K"]
        out.append("\033[J")
        # Keys only matter with the keyboard here: faint without it.
        key_rgb, what_rgb = (BRIGHT_RGB, MUTED_RGB) if FOCUS["pane"] else (DIMMED_RGB, DIMMED_RGB)
        pairs = [("j/k", "move"), ("space", "change"), ("esc", "close")] if self.settings_open else view.hints()
        hints = "  ".join(f"{fg(key_rgb)}{key} {fg(what_rgb)}{what}" for key, what in pairs)
        out += [f"\033[{rows};1H", bg(STRIP_RGB), " ", fit(hints, cols - 1), bg(STRIP_RGB), "\033[K", RESET]
        frame = "".join(out)
        if frame == self.last_frame:  # nothing changed: leave the screen alone
            return
        self.last_frame = frame
        # Kept for the next deck of this agent at this size: it shows it at once (see shown_cached).
        if time.time() - getattr(self, "cached_at", 0) > 2:
            self.cached_at = time.time()
            try:
                with open(frame_cache(), "w") as f:
                    f.write(frame)
            except OSError:
                pass
        # Synchronized output: terminals that support it show the frame at once.
        sys.stdout.write("\033[?2026h\033[H" + frame + "\033[?2026l")
        sys.stdout.flush()

    def mouse(self, button, col, row):
        """SGR mouse report: 0 = left press, 32 = drag with it held, 64/65 = wheel up/down."""
        if button == 32:
            getattr(self.views[self.section], "drag", lambda r, c: None)(row, col)
        elif button in (64, 65):
            self.views[self.section].wheel(button == 65, row)
        elif button == 0 and row == 1 and col <= CLOSE_W:
            self.closing = True
        elif button == 0 and row == 1:
            for i, x0, x1 in self.spans:
                if x0 <= col <= x1:
                    self.choose(i)
                    return
            # The scroll marks: ‹ picks the hidden tab before the shown ones, › the one after;
            # with something new that way (or a click on the count), the nearest new tab.
            if self.spans and col <= CLOSE_W + 1 and self.spans[0][0] > 0:
                left = [i for i in self.unseen if i < self.section]
                self.choose(max(left) if left else self.spans[0][0] - 1)
            elif self.spans and col > self.spans[-1][2]:
                right = [i for i in self.unseen if i > self.section]
                if right or self.unseen:
                    self.choose(min(right) if right else min(self.unseen))
                elif self.spans[-1][0] < len(self.views) - 1:
                    self.choose(self.spans[-1][0] + 1)
        elif button == 0:
            self.views[self.section].click(row, col)

    def key(self, k):
        view = self.views[self.section]
        if getattr(view, "search", None) is not None:  # typing a search: every key is text
            view.key(k)
            return
        if self.settings_open:  # the popup has the keys
            if k in ("j", "\t"):
                self.setting = min(len(SETTINGS) - 1, self.setting + 1)
            elif k in ("k", "\x1b[Z"):
                self.setting = max(0, self.setting - 1)
            elif k in (" ", "\r", "\n", "l", "h"):
                key, _, _, _, choices = SETTINGS[self.setting]
                if choices:  # the next value (h: the one before)
                    at = choices.index(self.settings[key]) + (-1 if k == "h" else 1)
                    self.settings[key] = choices[at % len(choices)]
                else:
                    self.settings[key] = not self.settings[key]
                save_settings(self.settings)
                CURRENT.update(self.settings)
            elif k in ("\x1b", ",", "q"):  # (q reaches here from the main loop)
                self.settings_open = False
            return
        if k == "," and not (view.focus == "log" and view.copy_cursor):
            self.settings_open, self.setting = True, 0
            return
        if k in ("\t", "\x1b[Z") and view.focus == "log":
            view.key(k)  # in a run's box, tab moves within it (a run's command and log; an agent's buttons)
        elif k in ("\t", "]"):
            self.choose(self.section + 1)
        elif k in ("\x1b[Z", "["):
            self.choose(self.section - 1)
        elif k.isdigit() and 1 <= int(k) <= len(self.views):
            self.choose(int(k) - 1)
        elif k in TAB_KEYS and not (view.focus == "log" and view.copy_cursor):
            self.choose(TAB_KEYS.index(k))  # shift+its letter; in a log, B stays a copy-mode key
        elif k == "L" and not getattr(self, "flipping", False):  # reopen beside / above the agent; this process goes with the old pane
            self.flipping = True  # more L while it moves would each start a flip of their own
            subprocess.Popen([os.path.join(os.path.dirname(os.path.abspath(__file__)), "deck"), "flip", BASE],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
        else:
            self.views[self.section].key(k)


_crash = ""
def crashed():
    """Append the current exception to <TMPDIR>/steading/crash.log, once per distinct traceback."""
    global _crash
    trace = traceback.format_exc()
    if trace == _crash:
        return
    _crash = trace
    try:
        with open(os.path.join(os.path.dirname(BASE), "crash.log"), "a") as f:
            f.write(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} {BASE}\n{trace}")
    except OSError:
        pass


def legacy(key):
    """A kitty keyboard protocol key (CSI code;mods u) as the bytes it stands for:
    esc, ctrl+letter as its control character, anything else as its character."""
    m = re.fullmatch(r"\x1b\[(\d+)(?:;(\d+))?u", key)
    if not m:
        return key
    code, mods = int(m.group(1)), int(m.group(2) or 1) - 1
    if mods & 4 and chr(code).isalpha():
        return chr(code & 0x1f)
    return chr(code)


def frame_cache():
    """The last frame a deck of this agent drew at this pane size."""
    cols, rows = shutil.get_terminal_size()
    return os.path.join(BASE, f"frame-{cols}x{rows}")


def shown_cached():
    """Show the last frame drawn at this size (a day old at most) while the runs load:
    a deck reopened, or moved by L, is not blank for its first second."""
    try:
        if time.time() - os.path.getmtime(frame_cache()) < 86400:
            with open(frame_cache()) as f:
                sys.stdout.write("\033[?2026h\033[H" + f.read() + "\033[?2026l")
                sys.stdout.flush()
    except OSError:
        pass


def main():
    deck = Deck()
    me = os.path.abspath(__file__)
    born = os.path.getmtime(me)
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)

    def restore():
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        sys.stdout.write("\033[?1004l\033[<u\033[?1006l\033[?1002l\033[?1000l\033[?7h\033[?25h\033[?1049l")
        sys.stdout.flush()

    # Alternate screen, hidden cursor, no autowrap (long lines are cut, not
    # wrapped), and SGR mouse reports so clicks and the wheel reach the deck.
    # Kitty keyboard protocol, disambiguate only: esc then comes as its own sequence, so
    # nothing on the way (herdr, the terminal) has to wait to tell it from an arrow key.
    sys.stdout.write("\033[?1049h\033[?25l\033[?7l\033[?1000h\033[?1002h\033[?1006h\033[>1u\033[?1004h")  # 1004: focus in/out reports
    shown_cached()
    try:
        tty.setcbreak(fd)
        while True:
            if os.path.getmtime(me) != born:  # edited: restart in place with the new code
                restore()
                os.execv(sys.executable, [sys.executable, me] + sys.argv[1:])
            try:
                deck.refresh()
                deck.draw()
            except Exception:  # a bad frame must not close the pane: note it and draw again
                crashed()
                time.sleep(0.5)
                continue
            try:
                fading = any(time.time() - getattr(v, "fresh", (None, 0))[1] < FADE_SECS for v in deck.views)
                if select.select([fd], [], [], 0.05 if fading else 0.3)[0]:
                    k = os.read(fd, 256).decode("utf-8", "replace")
                    events = MOUSE.findall(k)
                    for button, col, row, kind in events:
                        if kind == "M":  # press or drag
                            deck.mouse(int(button), int(col), int(row))
                        elif int(button) == 0:  # left button let go
                            getattr(deck.views[deck.section], "release", lambda: None)()
                    if getattr(deck, "closing", False):  # its ✕ was clicked
                        return
                    if events:
                        continue
                    # One read can hold several keys (fast presses, arrows): take them one at a time.
                    for key in KEYS.findall(k):
                        key = legacy(key)
                        view = deck.views[deck.section]
                        typing = getattr(view, "search", None) is not None
                        if key in ("\x1b[I", "\x1b[O"):  # the pane got or lost the keyboard
                            FOCUS["pane"] = key == "\x1b[I"
                            continue
                        if key == "\x03":  # ctrl+c, when the keyboard protocol sends it as a key, not a signal
                            return
                        if key == "q" and deck.settings_open:  # q closes the settings popup
                            deck.key(key)
                            continue
                        if key == "q" and not typing:
                            if getattr(view, "focus", "list") != "log":
                                continue  # a stray q no longer closes the deck: ctrl+c (or prefix+t) does
                            key = "\x1b"  # in a log, q goes back to the list as esc does
                        deck.key(key if typing else ARROWS.get(key, key))
            except Exception:  # nor a key that trips something
                crashed()
    except KeyboardInterrupt:
        pass
    finally:
        restore()


if __name__ == "__main__":
    main()
