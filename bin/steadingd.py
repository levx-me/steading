#!/usr/bin/env python3
"""One per machine: Steading's long-lived helpers as threads of one process, not one process
each. bin/usage.py ($usage, one for the machine) and bin/steading_run.py (the $wsrun refresher,
one per workspace) run here; bin/sidebar.py asks for them, and starts this when it does not answer.

  $TMPDIR/steading/daemon.pid   its pid, taken atomically (O_EXCL; a dead or foreign pid is stale)
  $TMPDIR/steading/daemon.sock  plain HTTP/1.0, one request at a time, in the order they came:
      GET  /ping                                                 {"pid": N}
      POST /start {"kind": "usage", "args": []}                  {"state": "started"|"running"|"elsewhere"}
      POST /start {"kind": "run", "args": [pane, workspace, cwd, "1"|"0" (has a repo)]}   the same
  $TMPDIR/steading/daemon.log   what a helper raised (emptied past 256 KB)

A helper's own pid file (usage.pid, run-<workspace>.pid) holds the daemon's pid while it runs
here, so one started as its own process the old way sees a live owner and exits; a pid file a
live standalone helper holds is left to it ("elsewhere"). A helper that ends or raises is started
again by the next /start. The daemon never exits on its own: it re-execs (the same pid) when its
code or a bin/ module it loaded changes, and runs the helpers again on the next /start. It ends
only once its pid file or socket is no longer its own (another took them, or the folder is gone).

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


def claim(pidfile, names):
    """Take the pid file for this process, made atomically (O_EXCL) so two starting at once cannot
    both win; a stale one is replaced. False when a live one of `names` holds it."""
    for _ in range(2):
        try:
            with open(pidfile) as f:
                if int(f.read()) == os.getpid():
                    return True  # re-exec'd, or the daemon's: the file is already ours
        except (OSError, ValueError):
            pass
        try:
            fd = os.open(pidfile, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            if running(pidfile, names):
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
    import http.server
    import socketserver
    import threading
    import traceback
    sys.path.insert(0, HERE)  # -I leaves the script's folder out
    import reexec, steading_run, usage  # noqa: E401

    os.makedirs(BASE, exist_ok=True)
    if not claim(PIDFILE, ("steadingd.py",)):
        return  # one per machine
    try:
        # The refresher's compute takes viewer.py's herdr_panes, read and Jobs: loaded once, before
        # the watcher, so an edit to it re-execs the daemon too. Its BASE (a deck's) is not used here.
        os.environ.setdefault("STEADING_BASE", BASE)
        steading_run.load("viewer", os.path.join(HERE, "viewer.py"))
    except Exception:
        log(traceback.format_exc())  # the refreshers will fail and log; usage still runs
    check = reexec.watcher(__file__, every=1)
    helpers = {}  # pid file: the thread running that helper

    def helper(pidfile, run):
        try:
            run()
        except Exception:
            log(traceback.format_exc())
        finally:
            release(pidfile)

    def start(kind, args):
        """The helper's state, None for a request that names none."""
        if kind == "usage" and args == []:
            pidfile, names, run = usage.PIDFILE, usage.OWNERS, lambda: usage.main(watch=False)
        elif kind == "run" and isinstance(args, list) and len(args) == 4 and all(isinstance(a, str) and a for a in args) \
                and args[3] in ("0", "1"):
            pane, space, cwd, has_repo = args
            state, pidfile = steading_run.paths(pane, space)
            names = steading_run.OWNERS
            run = lambda: steading_run.main(pane, space, cwd, has_repo == "1", state, watch=False)  # noqa: E731
        else:
            return None
        t = helpers.get(pidfile)
        if t and t.is_alive():
            return "running"
        if not claim(pidfile, names):
            return "elsewhere"  # a live standalone helper has it
        t = helpers[pidfile] = threading.Thread(target=helper, args=(pidfile, run), daemon=True)
        t.start()
        return "started"

    class Handler(http.server.BaseHTTPRequestHandler):
        timeout = 2  # a client that sends nothing cannot hold the others up

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

        def do_POST(self):
            if self.path != "/start":
                return self.reply(404, {"error": f"no {self.path}"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                state = start(body.get("kind"), body.get("args")) if isinstance(body, dict) else None
            except ValueError:
                state = None
            if state is None:
                return self.reply(400, {"error": 'want {"kind": "usage", "args": []} or {"kind": "run", "args": [pane, workspace, cwd, "1"|"0"]}'})
            self.reply(200, {"state": state})

    try:
        try:
            os.remove(SOCK)  # a killed daemon's is left behind
        except OSError:
            pass
        server = socketserver.UnixStreamServer(SOCK, Handler)
        os.chmod(SOCK, 0o600)  # this user's sessions only
        server.timeout = 1
        bound = os.stat(SOCK).st_ino

        def ours():
            try:
                with open(PIDFILE) as f:
                    return f.read() == str(os.getpid()) and os.stat(SOCK).st_ino == bound
            except OSError:
                return False

        while ours():
            server.handle_request()
            check()
    except OSError:
        log(traceback.format_exc())  # cannot bind: bin/sidebar.py runs the helpers on their own
    finally:
        release(PIDFILE)


if __name__ == "__main__":
    main()
