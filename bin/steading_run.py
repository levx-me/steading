#!/usr/bin/env python3
"""What runs in a workspace, for the Spaces panel's third row ($wsrun, with the guides $wstree and
$wstree2): the ports of its dev servers and the jobs still going.

bin/sidebar.py computes it on every hook; a server can stop with no hook to say so, so when
something runs it also starts this as a refresher (one per workspace, a pid file in the state
dir; run: steading_run.py PANE WORKSPACE CWD HAS_REPO). Every 10 s it recomputes and reports the
three tokens in one source with no lifetime, the same one the hooks use, so the two agree. Once
nothing runs it clears $wsrun and $wstree2, sets $wstree to "└", and exits, as it does when the
workspace is gone (herdr answers with an error). Servers outlive sessions: nothing else stops it."""
import glob, json, os, shutil, socket, subprocess, sys, time
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.environ.get("STEADING_SIDEBAR_TREE") != "0"
EVERY = float(os.environ.get("STEADING_RUN_EVERY", "10"))


def source(pane):
    return f"steading-run-{pane}"


def _sent_file(state, src):
    return os.path.join(state, "sent", src.replace(":", "_").replace("/", "_") + ".json")


def same_as_sent(state, src, tokens):
    """True when the last report for this source went out with these very tokens: herdr redraws the
    sidebar on every report, so an unchanged one is skipped."""
    try:
        with open(_sent_file(state, src)) as f:
            return json.load(f) == tokens
    except (OSError, ValueError):
        return False


def mark_sent(state, src, tokens):
    """Remember a report that succeeded (atomic write). Call it only after the report went through."""
    path = _sent_file(state, src)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(tokens, f)
        os.replace(tmp, path)
    except OSError:
        pass


def forget_sent(state):
    """A new session, or a herdr restart: the next report must go out whatever was sent before."""
    shutil.rmtree(os.path.join(state, "sent"), ignore_errors=True)


def compute(v, state, cwd, space):
    """The row's text: "▶ :3000 :5173 · ⏳ 1 job", empty when nothing runs."""
    shells = [sh for _, w, sh, _ in v.herdr_panes(True) if w == space]
    try:
        out = subprocess.run([os.path.join(HERE, "servers"), v.read(os.path.join(state, "root")) or cwd, *shells],
                             capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        out = ""
    ports = sorted({int(l.split("\t")[0]) for l in out.splitlines() if "\t" in l})
    jobs = [p for p in glob.glob(os.path.join(state, "jobs", "runs", "*")) if not os.path.exists(os.path.join(p, "end")) and v.Jobs.shows(p)]
    return " · ".join(([("▶ " + " ".join(f":{n}" for n in ports[:4]))] if ports else []) + ([f"⏳ {len(jobs)} job{'s' * (len(jobs) > 1)}"] if jobs else []))


def tokens(run, has_repo):
    """Guides for the Spaces rows [wsrepo, wsrun]: "├" on a row another follows, "└" on the last one shown."""
    return {"wstree": ("├" if run else "└") if TREE and has_repo else "", "wsrun": run, "wstree2": "└" if TREE and run else ""}


def call(method, params):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(2)
    s.connect(os.environ["HERDR_SOCKET_PATH"])
    s.sendall((json.dumps({"id": "steading-run", "method": method, "params": params}) + "\n").encode())
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    s.close()
    reply = json.loads(buf or b"{}")
    if "error" in reply or "result" not in reply:
        raise OSError(f"herdr: {reply.get('error')}")
    return reply["result"]


def report(pane, space, run, has_repo, state, force=False):
    """Skipped when it repeats the last one sent (the first report of a refresher is never skipped)."""
    sent = {k: v or None for k, v in tokens(run, has_repo).items()}
    if not force and same_as_sent(state, source(pane), sent):
        return
    call("workspace.report_metadata", {"workspace_id": space, "source": source(pane), "tokens": sent})
    mark_sent(state, source(pane), sent)


def main(pane, space, cwd, has_repo, state):
    v = SourceFileLoader("viewer", os.path.join(HERE, "viewer.py")).load_module()
    first = True
    while True:
        time.sleep(EVERY)
        run = compute(v, state, cwd, space)
        report(pane, space, run, has_repo, state, force=first)
        first = False
        if not run:
            return


if __name__ == "__main__":
    pane, space, cwd, has_repo = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
    base = os.path.join(os.environ.get("TMPDIR", "/tmp"), "steading")
    state = os.path.join(base, pane.replace(":", "_").replace("/", "_"))
    os.environ.setdefault("STEADING_BASE", state)
    os.makedirs(base, exist_ok=True)
    pidfile = os.path.join(base, "run-" + space.replace(":", "_").replace("/", "_") + ".pid")
    try:  # one refresher per workspace
        os.kill(int(open(pidfile).read()), 0)
        sys.exit(0)
    except (OSError, ValueError):
        pass
    with open(pidfile, "w") as f:
        f.write(str(os.getpid()))
    try:
        main(pane, space, cwd, has_repo, state)
    except (OSError, ValueError, KeyError):
        pass
    finally:
        try:
            if open(pidfile).read() == str(os.getpid()):
                os.remove(pidfile)
        except OSError:
            pass
