"""What a Claude Code transcript says about its agent, and what a deck keeps of it between runs.

The parser: Digest, fed one transcript line at a time, and the phrases it stores for each call
(tool_summary); the reads that feed it a transcript's new lines (read_main for the main agent,
read_agent for a subagent), over a plain state dict; and the cache of that state, one file per
transcript under $STEADING_CACHE (else ${XDG_CACHE_HOME:-~/.cache}/steading), keyed by this
file's source and bin/classify's. Editing the deck's drawing (viewer.py) keeps every cache;
editing the parser drops them. The cache holds plain data only, no class: a deck runs viewer.py
as __main__, sidebar.py imports this, and both read the same files.

Standard library only; runs on Python 3.9 to 3.15."""
import hashlib
import importlib.util
import json
import os
import pickle
import re
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

import subagents  # (bin/ is on the path of whoever imports this)

HERE = os.path.dirname(os.path.abspath(__file__))


def _classify():
    """bin/classify, loaded once: the shell-token reading both hooks use."""
    global _CLASSIFY
    if "_CLASSIFY" not in globals():
        from importlib.machinery import SourceFileLoader
        loader = SourceFileLoader("classify", os.path.join(HERE, "classify"))
        _CLASSIFY = importlib.util.module_from_spec(importlib.util.spec_from_loader("classify", loader))
        sys.modules["classify"] = _CLASSIFY
        loader.exec_module(_CLASSIFY)
    return _CLASSIFY


# What a deck has parsed of a transcript is kept between runs, so a deck starting beside a
# long session reads only what came after. Our own local file, keyed by the transcript's path
# and by the parser's source (a change to this file or bin/classify drops every old cache).
CACHE = os.environ.get("STEADING_CACHE") or os.path.join(
    os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "steading")


def _source(path):
    with open(path, "rb") as f:
        return f.read()


PARSER = hashlib.sha1(_source(os.path.join(HERE, "transcripts.py")) + _source(os.path.join(HERE, "classify"))).hexdigest()
TAIL, EVERY = 64, 20  # bytes checked before the offset; seconds between saves of one file
KEEP = 14 * 86400  # a cache file untouched this long is pruned (a live transcript's is rewritten every EVERY s)


def cache_file(path):
    return os.path.join(CACHE, hashlib.sha1(path.encode()).hexdigest())


def tail_of(path, end):
    with open(path, "rb") as f:
        f.seek(max(0, end - TAIL))
        return f.read(min(TAIL, end))


CHUNK = 1 << 24  # a transcript is read 16 MB at a time: one of 500 MB is never held whole


def read_chunk(f):
    """The next CHUNK bytes of f, and the rest of the line they end in."""
    data = f.read(CHUNK)
    return data + f.readline() if len(data) == CHUNK else data


def cache_load(path):
    """The saved parse state of a transcript that is still the same file and only grew, else None."""
    try:
        with open(cache_file(path), "rb") as f:
            saved = pickle.load(f)
        st = os.stat(path)
        if (saved["parser"], saved["path"], saved["ino"], saved["dev"]) != (PARSER, path, st.st_ino, st.st_dev):
            return None
        state = saved["state"]
        end = state["read_to"]
        if st.st_size < end or tail_of(path, end) != saved["tail"]:
            return None
        digest = Digest()
        digest.__dict__.update(state["digest"])  # kept as plain data
        state["digest"] = digest
        return state
    except Exception:  # missing, empty, corrupt, from another parser: parse it all
        return None


def cache_save(path, owner, state, force=False):
    """Keep state (its read_to is the offset it stands at), at most every EVERY seconds per owner
    (the state dict it reads into), or now with force."""
    if not force and time.time() - owner.get("kept_at", 0) < EVERY:
        return
    owner["kept_at"] = time.time()
    try:
        st = os.stat(path)
        os.makedirs(CACHE, exist_ok=True)
        tmp = f"{cache_file(path)}.{os.getpid()}.{threading.get_ident()}"
        with open(tmp, "wb") as f:  # protocol 4: Python 3.9 and 3.15 read each other's
            pickle.dump({"parser": PARSER, "path": path, "ino": st.st_ino, "dev": st.st_dev,
                         "state": dict(state, digest=state["digest"].__dict__),
                         "tail": tail_of(path, state["read_to"])}, f, 4)
        os.replace(tmp, cache_file(path))
    except Exception:
        pass


def prune(now=None):
    """Remove the cache files untouched for KEEP seconds. Never raises: a deck runs it once at start."""
    now = now or time.time()
    try:
        for entry in os.scandir(CACHE):
            try:
                if now - entry.stat().st_mtime > KEEP:
                    os.remove(entry.path)
            except OSError:
                pass
    except Exception:
        pass


NOTIFICATION = re.compile(r"<task-id>([^<]+)</task-id>.*?<status>([^<]+)</status>", re.S)


def datetime_epoch(ts):
    from datetime import datetime
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


STAMP = re.compile(rb'"timestamp":"([0-9T:.\-]+Z)"')


TOOL_KINDS = {"Read": "read", "NotebookRead": "read", "Grep": "search", "Glob": "search", "WebSearch": "search",
              "WebFetch": "search", "ToolSearch": "search", "Edit": "edit", "MultiEdit": "edit", "Write": "edit",
              "NotebookEdit": "edit", "Bash": "run", "Agent": "agent", "Task": "agent", "Workflow": "agent"}
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
        self.model = self.effort = self.requested = self.title = ""
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

    disk = None  # the real task list [(id, subject, status)] from Claude Code's folder; None: go by the talk

    def listed(self):
        """The tasks to show: Claude Code's own list when read from disk (the talk keeps every
        older process's list too), else what the talk built. {id: [subject, status]}."""
        tasks = self.tasks if self.disk is None else {tid: [subject, st] for tid, subject, st in self.disk}
        # What is left on top (doing, then to do), the done ones after; newest first in each:
        # the higher id, or for ids that are not numbers the one added later.
        rank = {"in_progress": 0, "pending": 1}
        order = sorted(enumerate(tasks), key=lambda it: (rank.get(tasks[it[1]][1], 2),
                                                         -int(it[1]) if it[1].isdigit() else 0, -it[0]))
        return {tid: tasks[tid] for _, tid in order}

    def story(self, tid):
        """A task's story in the talk. Ids restart with each process, so a disk task finds its
        story by subject when the same id in the talk is another task."""
        if self.disk is None:
            return self.task_log.get(tid, [])
        subject = self.listed().get(tid, ["", ""])[0]
        if tid in self.tasks and self.tasks[tid][0] == subject:
            return self.task_log.get(tid, [])
        same = [t for t, (s, _) in self.tasks.items() if s == subject]
        return self.task_log.get(same[-1], []) if same else []

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
        # The session's title: one the user set wins over Claude's own.
        if row.get("type") == "custom-title" and row.get("customTitle"):
            self.title, self.titled = row["customTitle"], True
        elif row.get("type") == "ai-title" and row.get("aiTitle") and not getattr(self, "titled", False):
            self.title = row["aiTitle"]
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
        usage = {k: v for k, v in (msg.get("usage") or {}).items() if v is not None}  # a null count reads as absent
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


def statusline_context(sid):
    """(percent, window) from the JSON Claude Code gave the statusline for this session, which the
    optional statusline hook saved (docs/how-it-works.md); None when absent, other or older than 10 minutes."""
    path = os.path.join(tempfile.gettempdir(), "steading", "statusline", f"{sid}.json")
    try:
        if not sid or time.time() - os.path.getmtime(path) > 600:
            return None
        with open(path) as f:
            j = json.load(f)
        w = j["context_window"]
        size = int(w["context_window_size"])
        if j.get("session_id") != sid or size <= 0:
            return None
        return min(100, int(w["used_percentage"])), size
    except (OSError, ValueError, KeyError, TypeError):
        return None


def context_use(d):
    """(percent of the window used, the window) for a digest. The statusline's own numbers when
    saved; else a guess: a 1M-window model says so in its name, or has already gone past the usual limit."""
    saved = statusline_context(getattr(d, "sid", ""))
    if saved:
        return saved
    limit = 1_000_000 if "[1m]" in (d.requested or "") or d.context > CONTEXT_LIMIT else CONTEXT_LIMIT
    return (min(100, d.context * 100 // limit) if d.context else 0), limit


def agent_state(path):
    """A subagent transcript's state: what an earlier deck kept of it, else nothing read yet."""
    s = {"read_to": 0, "digest": Digest(), "stamps": [], "launched": {}, "ended_tasks": set()}
    s.update(cache_load(path) or {})
    return s


def read_agent(path, s):
    """Feed a subagent transcript's new lines (its file only grows) to its state s, a chunk at a
    time, to the end. False when there was nothing new or the file could not be read."""
    start, behind = s["read_to"], False
    try:
        if s.get("counted") == s["read_to"] == os.path.getsize(path):
            return False  # nothing new since the last count: not even opened
        with open(path, "rb") as f:
            f.seek(s["read_to"])
            while True:
                data = read_chunk(f)
                done = data.rfind(b"\n") + 1
                subagents.scan_background(data[:done], s["launched"], s["ended_tasks"])
                digest, stamps = s["digest"], s["stamps"]
                for raw in data[:done].splitlines():
                    try:
                        row = json.loads(raw)
                    except ValueError:
                        continue
                    digest.feed(row)
                    if digest.last and (not stamps or stamps[-1] != digest.last):
                        stamps.append(digest.last)
                s["read_to"] += done
                if len(data) < CHUNK or done < len(data):  # the end, or a half-written last line
                    break
                behind = True
    except OSError:
        return False
    s["counted"] = s["read_to"]
    if s["read_to"] != start:  # after more than a chunk, the end it caught up to is kept now, throttle or not
        cache_save(path, s, {k: s[k] for k in ("read_to", "digest", "stamps", "launched", "ended_tasks")}, behind)
    return True


def read_main(path, s):
    """What the main transcript has said since the last read, into its state s: answers to Agent
    calls and task notifications. One chunk a call: a big transcript is read on over the next
    calls (from what an earlier deck kept of it, on the first), then only its new lines."""
    if s.get("cached") != path:  # first read of this session: start from what an earlier deck kept
        s["cached"] = path
        s.update((s["read_to"] == 0 and cache_load(path)) or {})
    try:
        with open(path, "rb") as f:
            f.seek(s["read_to"])
            data = read_chunk(f)
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
            s["stamps"].append(t)
    s["stamps"] = [t for t in s["stamps"] if t > horizon]
    results, notified, notified_at = s["results"], s["notified"], s["notified_at"]
    for raw in data[:done].splitlines():
        try:
            row = json.loads(raw)
        except ValueError:
            continue
        s["digest"].feed(row)
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
                results[b.get("tool_use_id")] = bool(b.get("is_error"))
            text = b.get("text") if b.get("type") == "text" else None
            if isinstance(text, str) and "<task-notification>" in text:
                try:
                    when = datetime_epoch(row["timestamp"])
                except (KeyError, TypeError, ValueError):
                    when = time.time()
                for agent, status in NOTIFICATION.findall(text):
                    notified[agent.strip()] = {"completed": "done", "failed": "failed"}.get(
                        status.strip(), "stopped" if status.strip() in ("stopped", "killed") else "")
                    notified_at[agent.strip()] = when
    s["read_to"] += done
    # A deck catching up on a long transcript keeps the end it reached at once: saved only on the
    # throttle, a restart would start again from an early chunk.
    caught_up = len(data) < CHUNK and s.pop("behind", False)
    if len(data) >= CHUNK:
        s["behind"] = True
    if done or caught_up:
        cache_save(path, s, {k: s[k] for k in ("read_to", "digest", "results", "notified", "notified_at", "stamps")},
                   caught_up)


def git_state(root):
    """(branch, commits ahead, commits behind, files changed) from git status; None outside a repository."""
    try:
        out = subprocess.run(["git", "-C", root, "status", "--porcelain=v2", "--branch"],
                             capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if not root or out.returncode:
        return None
    branch, ahead, behind, changed = "", 0, 0, 0
    for line in out.stdout.splitlines():
        if line.startswith("# branch.head "):
            branch = line.split(" ", 2)[2]
        elif line.startswith("# branch.ab "):
            a, b = line.split()[2:4]
            ahead, behind = int(a), -int(b)
        elif not line.startswith("#"):
            changed += 1
    return branch, ahead, behind, changed
