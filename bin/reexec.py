"""Long-lived helpers (bin/crew, usage.py, steading_run.py) start the code they find and would
keep it for hours. `check = reexec.watcher()` after the imports; calling `check()` in the loop
then re-execs the process, same pid and argv, once its own file or a module it imported from
bin/ changed mtime. Looks at most every `every` seconds."""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def sources(main_file):
    """The helper's file and every module loaded from bin/."""
    files = {os.path.abspath(main_file)}
    for mod in list(sys.modules.values()):
        path = getattr(mod, "__file__", None)
        if path and os.path.dirname(os.path.abspath(path)) == HERE:
            files.add(os.path.abspath(path))
    return files


def mtimes(files):
    out = {}
    for f in files:
        try:
            out[f] = os.stat(f).st_mtime_ns
        except OSError:
            out[f] = 0
    return out


def watcher(main_file=None, every=3, exec_=os.execv):
    files = sources(main_file or sys.argv[0])
    born, last = mtimes(files), [time.time()]

    def check():
        if time.time() - last[0] < every:
            return
        last[0] = time.time()
        if mtimes(files) != born:
            exec_(sys.executable, [sys.executable, "-I", os.path.abspath(sys.argv[0]), *sys.argv[1:]])

    return check
