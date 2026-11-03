#!/usr/bin/env python3
"""One per machine: Steading's long-lived helpers as threads of one process, not one process
each. bin/usage.py ($usage, one for the machine), bin/steading_run.py (the $wsrun refresher,
one per workspace) and bin/crew (the $crew spinner, one per pane) run here; bin/sidebar.py asks
for them, and starts this when it does not answer. It also samples the machine for the decks'
System tab while one shows it (below).

  $TMPDIR/steading/daemon.pid   its pid, taken atomically (O_EXCL; a dead or foreign pid is stale)
  $TMPDIR/steading/daemon.sock  plain HTTP/1.0, one request at a time, in the order they came:
      GET  /ping                                                 {"pid": N}
      POST /start {"kind": "usage", "args": []}                  {"state": "started"|"running"|"elsewhere"}
      POST /start {"kind": "run", "args": [pane, workspace, cwd, "1"|"0" (has a repo)]}   the same
      POST /start {"kind": "crew", "args": [pane, subagents folder]}                     the same
      a body over 64 KB is refused (413); past 64 helpers it answers 503, and bin/sidebar.py runs
      that one as its own process
      POST /hook/sidebar   the hook's event, its ENV (bin/sidebar.py) in "Env: NAME=value" headers:
      bin/sidebar's hand-off. A subagent's start or stop and a new process are recorded
      (bin/subagents.py) before it answers 200, in the order the hooks came; the rest of
      sidebar.run then waits its turn on one worker thread (a slow herdr holds up no hook).
      Anything but 200 means it did nothing, and the hook runs the scripts as before: a bad
      body (400), one over 16 MB (413), 200 events waiting (503), or a hook gone before its turn
  $TMPDIR/steading/daemon.log   what a helper raised (emptied past 256 KB)
  $TMPDIR/steading/daemon.helpers.json   the helpers it runs, [[kind, args], ...]: started again
                                when it starts (after a re-exec or a crash), dropped as each ends
  $TMPDIR/steading/system.want  touched by a deck showing the System tab (at most once a second);
                                while it is under 5 s old a thread samples every SAMPLE_SECS with
                                the deck's own code (macmon runs here then) and writes system.json
                                as a deck would, marking the servers the decks name in
                                <pane>/system.servers; the decks just draw it

A helper's own pid file (usage.pid, run-<workspace>.pid) holds the daemon's pid while it runs
here, so one started as its own process the old way sees a live owner and exits; a pid file a
live standalone helper holds is left to it ("elsewhere"). A helper that ends or raises is started
again by the next /start. The daemon never exits on its own: it re-execs (the same pid) when its
code or a bin/ module it loaded changes, and starts its helpers again. It ends only once its pid
file or socket is no longer its own (another took them, or the folder is gone).

    steadingd.py

`import steadingd` stays cheap for bin/sidebar.py (ask): the server is loaded in main."""
import json
import os
import socket
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(os.environ.get("TMPDIR", "/tmp"), "steading")
SOCK = os.path.join(BASE, "daemon.sock")
PIDFILE = os.path.join(BASE, "daemon.pid")
LOG = os.path.join(BASE, "daemon.log")
HELPERS = os.path.join(BASE, "daemon.helpers.json")
MAX_HELPERS = 64  # threads; past it a helper runs as its own process (the daemon answers 503)
MAX_BODY = 64 * 1024
MAX_EVENT = 16 << 20  # a hook's event holds the tool's input and output
MAX_QUEUE = 200  # events waiting for the worker; past it the hook runs bin/sidebar.py itself
WANT = os.path.join(BASE, "system.want")


def ask(path, body=None, timeout=1):
    """The daemon's JSON answer to GET path, or POST body to it. OSError (or ValueError) when it
    does not answer 200."""
    data = b"" if body is None else json.dumps(body).encode()
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(timeout)
        s.connect(SOCK)
        s.sendall(f"{'GET' if body is None else 'POST'} {path} HTTP/1.0\r\nContent-Length: {len(data)}\r\n\r\n".encode() + data)
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    if head.split(b" ")[1:2] != [b"200"]:
        raise OSError(f"steadingd: {head.splitlines()[0] if head else 'no answer'}")
    return json.loads(rest)


def running(pidfile, names):
    """Whether the pid in pidfile is alive and runs one of these scripts (a dead pid, or one
    reused by another program, is not)."""
    try:
        with open(pidfile) as f:
            pid = int(f.read())
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    args = subprocess.run(["ps", "-o", "args=", "-p", str(pid)], capture_output=True, text=True).stdout
    return any(os.path.basename(word) in names for word in args.split())  # its script, not a command naming it


def held(pidfile):
    try:
        with open(pidfile) as f:
            return f.read()
    except OSError:
        return None


def claim(pidfile, names):
    """Take the pid file for this process, made atomically (the pid is written to a file of its
    own, then linked in place: two starting at once cannot both win, and none ever sees it empty);
    a stale one is replaced. False when a live one of `names` holds it."""
    me = str(os.getpid())
    for _ in range(2):
        was = held(pidfile)
        if was == me:
            return True  # re-exec'd, or the daemon's: the file is already ours
        tmp = f"{pidfile}.{me}"
        with open(tmp, "w") as f:
            f.write(me)
        try:
            os.link(tmp, pidfile)
            return True
        except FileExistsError:
            pass
        finally:
            os.remove(tmp)
        if running(pidfile, names):
            return False
        # ponytail: another claimant can still take the stale file between this read and the
        # remove, and both win: two daemons then end in one (ours()), two helpers both run until
        # they end. A lock file (fcntl.flock) would close it.
        if held(pidfile) == was:
            try:
                os.remove(pidfile)
            except OSError:
                pass
    return False


def release(pidfile):
    """Remove the pid file if it still holds this process."""
    try:
        with open(pidfile) as f:
            if f.read() == str(os.getpid()):
                os.remove(pidfile)
    except OSError:
        pass


def log(text):
    import time
    try:
        if os.path.getsize(LOG) > 256 * 1024:
            os.remove(LOG)
    except OSError:
        pass
    try:
        with open(LOG, "a") as f:
            f.write(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} pid {os.getpid()}\n{text}")
    except OSError:
        pass


def main():
    import glob
    import http.server
    import queue
    import select
    import socketserver
    import threading
    import time
    import traceback
    import types
    sys.path.insert(0, HERE)  # -I leaves the script's folder out
    import reexec, steading_run, usage  # noqa: E401
    import files, sidebar, subagents, tasklist, transcripts  # noqa: E401,F401 (loaded before the watcher: an edit re-execs)

    os.makedirs(BASE, exist_ok=True)
    if not claim(PIDFILE, ("steadingd.py",)):
        return  # one per machine
    crew = v = None
    try:
        crew = steading_run.load("crew", os.path.join(HERE, "crew"))
    except Exception:
        log(traceback.format_exc())
    try:
        # The refresher's compute takes viewer.py's herdr_panes, read and Jobs, the System sampler
        # its System: loaded once, before the watcher, so an edit to it re-execs the daemon too.
        # Its BASE is a deck's, whose parent holds system.json and crash.log: this folder.
        os.environ.setdefault("STEADING_BASE", os.path.join(BASE, "daemon"))
        v = steading_run.load("viewer", os.path.join(HERE, "viewer.py"))
    except Exception:
        log(traceback.format_exc())  # the refreshers will fail and log; usage and crew still run

    def stop_macmon():
        """The sampler's macmon, ended and reaped (an exec would leave it a zombie under the new code)."""
        p = v and v._macmon["proc"]
        if p and p.poll() is None:
            p.kill()
            p.wait()

    events = queue.Queue(MAX_QUEUE)  # (event, env) for sidebar.run, in the order the hooks came

    def work():
        while True:
            event, env = events.get()
            try:
                sidebar.run(event, env, start)
            except Exception:
                log(traceback.format_exc())
            finally:
                events.task_done()

    def reexec_(py, argv):
        events.join()  # what was accepted is done first (each herdr or git call gives up in 5 s)
        stop_macmon()
        os.execv(py, argv)

    check = reexec.watcher(__file__, every=1, exec_=reexec_)
    helpers = {}  # pid file: the thread running that helper
    asked = {}    # pid file: [kind, args] of each running, as daemon.helpers.json holds them
    lock = threading.Lock()

    def save():
        tmp = f"{HELPERS}.{os.getpid()}"
        try:
            with open(tmp, "w") as f:
                json.dump(list(asked.values()), f)
            os.replace(tmp, HELPERS)
        except OSError:
            pass

    def helper(pidfile, run):
        try:
            run()
        except Exception:
            log(traceback.format_exc())
        finally:
            release(pidfile)
            with lock:
                asked.pop(pidfile, None)
                save()

    starting = threading.Lock()  # /start's and the worker's

    def start(kind, args):
        with starting:
            return start_(kind, args)

    def start_(kind, args):
        """The helper's state, None for a request that names none (or a pane "." or "..", which
        would name a folder above the state dirs)."""
        if isinstance(args, list) and (args[:1] in (["."], [".."]) or any("\0" in a for a in args if isinstance(a, str))):
            return None
        if kind == "usage" and args == []:
            pidfile, names, run = usage.PIDFILE, usage.OWNERS, lambda: usage.main(watch=False)
        elif kind == "run" and isinstance(args, list) and len(args) == 4 and all(isinstance(a, str) and a for a in args) \
                and args[3] in ("0", "1"):
            pane, space, cwd, has_repo = args
            state, pidfile = steading_run.paths(pane, space)
            names = steading_run.OWNERS
            run = lambda: steading_run.main(pane, space, cwd, has_repo == "1", state, watch=False)  # noqa: E731
        elif kind == "crew" and crew and isinstance(args, list) and len(args) == 2 and all(isinstance(a, str) and a for a in args):
            pane, folder = args
            state, pidfile = crew.paths(pane)
            os.makedirs(state, exist_ok=True)
            names = crew.OWNERS
            run = lambda: crew.main(pane, folder, state, watch=False)  # noqa: E731
        else:
            return None
        t = helpers.get(pidfile)
        if t and t.is_alive():
            return "running"
        for done in [f for f, t in helpers.items() if not t.is_alive()]:
            del helpers[done]
        if len(helpers) >= MAX_HELPERS:
            return "full"
        if not claim(pidfile, names):
            return "elsewhere"  # a live standalone helper has it
        with lock:
            asked[pidfile] = [kind, args]
            save()
        t = helpers[pidfile] = threading.Thread(target=helper, args=(pidfile, run), daemon=True)
        t.start()
        return "started"

    def deck_servers():
        """The dev servers the decks on the System tab name (each its project's), to mark."""
        found = []
        for path in glob.glob(os.path.join(BASE, "*", "system.servers")):
            try:
                if time.time() - os.path.getmtime(path) < 5:
                    with open(path) as f:
                        found += [tuple(s) for s in json.load(f) if isinstance(s, list) and len(s) == 3]
            except (OSError, ValueError, TypeError):
                pass
        return found

    def wanted():
        try:
            return time.time() - os.path.getmtime(WANT) < 5
        except OSError:
            return False

    def sample():
        """The System tab's sampler, while a deck shows it: the deck's own System.sample, so
        system.json is what a deck would write, and the decks' election finds it fresh."""
        s = v.System(types.SimpleNamespace(found=[]))
        try:
            while wanted():
                s.servers.found = deck_servers()
                s.sample()
                time.sleep(max(1.0, s.sampled_at + v.SAMPLE_SECS - time.time()))  # 1 s at least: a failing sample leaves sampled_at 0
        finally:
            stop_macmon()

    sampler = [None]

    def system():
        """The sampler started when a deck wants it and none runs (one stat a loop otherwise)."""
        if v and not (sampler[0] and sampler[0].is_alive()) and wanted():
            sampler[0] = threading.Thread(target=sample, daemon=True)
            sampler[0].start()

    class Handler(http.server.BaseHTTPRequestHandler):
        timeout = 0.5  # a client that sends nothing cannot hold the others up

        def log_message(self, *args):
            pass

        def reply(self, code, answer):
            data = json.dumps(answer).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/ping":
                self.reply(200, {"pid": os.getpid()})
            else:
                self.reply(404, {"error": f"no {self.path}"})

        def gone(self):
            """Whether the client hung up (its wait ran out: it runs the hook's scripts itself)."""
            try:
                return bool(select.select([self.connection], [], [], 0)[0]) and not self.connection.recv(1, socket.MSG_PEEK)
            except OSError:
                return True

        def hook(self):
            try:
                size = int(self.headers.get("Content-Length") or 0)
                if size > MAX_EVENT:
                    return self.reply(413, {"error": f"a body over {MAX_EVENT} bytes"})
                event = json.loads(self.rfile.read(max(0, size)) or b"{}")
            except ValueError:
                event = None
            if not isinstance(event, dict):
                return self.reply(400, {"error": "want the hook's event, a JSON object"})
            if events.full():
                return self.reply(503, {"error": f"{MAX_QUEUE} events wait"})
            if self.gone():
                return  # ponytail: one that hangs up between this and the answer is handled twice
            env = {k: w for k, w in os.environ.items() if k not in sidebar.ENV}
            for line in self.headers.get_all("Env") or []:
                k, _, w = line.partition("=")
                if k in sidebar.ENV:
                    env[k] = w.encode("latin-1").decode("utf-8", "surrogateescape")  # (headers come as latin-1)
            name = event.get("hook_event_name")
            if name in ("SubagentStart", "SubagentStop", "TeammateIdle", "SessionStart"):
                try:
                    subagents.record(BASE, event)
                except (OSError, ValueError, AttributeError):
                    pass  # as the script: a hook never fails the session
            if name not in ("SubagentStop", "TeammateIdle"):  # nothing more to report
                events.put((event, env))
            self.reply(200, {"state": "accepted"})

        def do_POST(self):
            if self.path == "/hook/sidebar":
                return self.hook()
            if self.path != "/start":
                return self.reply(404, {"error": f"no {self.path}"})
            try:
                size = int(self.headers.get("Content-Length") or 0)
                if size > MAX_BODY:
                    return self.reply(413, {"error": f"a body over {MAX_BODY} bytes"})
                body = json.loads(self.rfile.read(max(0, size)) or b"{}")
                state = start(body.get("kind"), body.get("args")) if isinstance(body, dict) else None
            except ValueError:
                state = None
            if state == "full":
                return self.reply(503, {"error": f"{MAX_HELPERS} helpers run"})
            if state is None:
                return self.reply(400, {"error": 'want {"kind": "usage", "args": []}, {"kind": "run", "args": [pane, workspace, cwd, "1"|"0"]}'
                                                 ' or {"kind": "crew", "args": [pane, folder]}'})
            self.reply(200, {"state": state})

    try:
        try:
            os.remove(SOCK)  # a killed daemon's is left behind
        except OSError:
            pass
        class Server(socketserver.UnixStreamServer):
            request_queue_size = 128  # a burst of hooks waits its turn, not refused (5 by default)

        server = Server(SOCK, Handler)
        os.chmod(SOCK, 0o600)  # this user's sessions only
        server.timeout = 1
        bound = os.stat(SOCK).st_ino
        try:  # the helpers it ran before a re-exec or a crash
            with open(HELPERS) as f:
                before = json.load(f)
        except (OSError, ValueError):
            before = []
        for entry in before if isinstance(before, list) else []:
            try:
                if isinstance(entry, list) and len(entry) == 2:
                    start(*entry)
            except OSError:
                log(traceback.format_exc())
        with lock:
            save()  # only those that run now
        threading.Thread(target=work, daemon=True).start()

        def ours():
            try:
                with open(PIDFILE) as f:
                    return f.read() == str(os.getpid()) and os.stat(SOCK).st_ino == bound
            except OSError:
                return False

        while ours():
            server.handle_request()
            check()
            system()
    except OSError:
        log(traceback.format_exc())  # cannot bind: bin/sidebar.py runs the helpers on their own
    finally:
        events.join()
        stop_macmon()
        release(PIDFILE)


if __name__ == "__main__":
    main()
