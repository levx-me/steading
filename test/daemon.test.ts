import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// Everything runs in a scratch TMPDIR against a fake herdr: its socket (one claude pane, test:p0
// in w1, whose claude is the fake itself) and its CLI (`pane get` names the workspace).
const started: number[] = []; // every pid a test started or saw as a daemon or helper: killed after it
const dirs: string[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) try { process.kill(pid, "SIGKILL"); } catch {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until<T>(fn: () => T, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end) return v;
    await Bun.sleep(50);
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidIn = (file: string) => { try { return Number(readFileSync(file, "utf8")); } catch { return 0; } };

async function setup(opts: { tmp?: string; bin?: string } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sd-")));
  dirs.push(dir);
  const tmp = opts.tmp ? join(dir, opts.tmp) : dir;
  const base = join(tmp, "steading");
  mkdirSync(base, { recursive: true });
  const sock = join(dir, "herdr.sock");
  const log = join(dir, "herdr.log");
  const fake = Bun.spawn(["python3", "-c", `
import json, os, socketserver, sys
class H(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline().decode()
        open(sys.argv[2], "a").write(line)
        method = json.loads(line)["method"]
        result = {"pane.list": {"panes": [{"pane_id": "test:p0", "workspace_id": "w1", "agent": "claude"}]},
                  "pane.process_info": {"process_info": {"shell_pid": os.getpid(),
                      "foreground_processes": [{"pid": os.getpid(), "name": "claude", "argv0": "claude"}]}}}.get(method, {})
        self.wfile.write((json.dumps({"result": result}) + "\\n").encode())
socketserver.UnixStreamServer(sys.argv[1], H).serve_forever()`, sock, log]);
  started.push(fake.pid);
  await until(() => existsSync(sock));
  const cli = join(dir, "herdr");
  writeFileSync(cli, `#!/bin/sh\n[ "$1 $2" = "pane get" ] && echo '{"result":{"pane":{"workspace_id":"w1","tab_id":"w1:t1"}}}'\nexit 0\n`);
  chmodSync(cli, 0o755);
  const www = join(dir, "www");
  mkdirSync(www);
  // A job that runs (no end, started a minute ago): the refresher keeps going while it does.
  const job = join(base, "test_p0", "jobs", "runs", "j1");
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "start"), String(Math.floor(Date.now() / 1000) - 60));
  const env: Record<string, string> = { PATH: process.env.PATH!, HOME: dir, TMPDIR: tmp, HERDR_ENV: "1", HERDR_PANE_ID: "test:p0",
    HERDR_SOCKET_PATH: sock, HERDR_BIN_PATH: cli, STEADING_RUN_EVERY: "0.3", GIT_CEILING_DIRECTORIES: dir };
  const bin = opts.bin ?? join(root, "bin");
  const daemon = (unset: string[] = []) => {
    const e = { ...env };
    for (const k of unset) delete e[k];
    const p = Bun.spawn([join(bin, "py"), "-I", join(bin, "steadingd.py")], { env: e, stdout: "ignore", stderr: "ignore" });
    started.push(p.pid);
    return p;
  };
  // steadingd.ask, as bin/sidebar.py calls it: the answer, or the error's text.
  const ask = (path: string, body?: object) => {
    const r = Bun.spawnSync(["python3", "-I", "-c", `import json, sys
sys.path.insert(0, ${JSON.stringify(bin)})
import steadingd
try:
    print(json.dumps(steadingd.ask(sys.argv[1], json.loads(sys.argv[2]) if sys.argv[2] else None)))
except (OSError, ValueError) as e:
    print(json.dumps({"failed": str(e)}))`, path, body ? JSON.stringify(body) : ""], { env });
    return JSON.parse(r.stdout.toString());
  };
  const sidebar = () => Bun.spawnSync(["python3", "-I", join(bin, "sidebar.py")], { env, cwd: www,
    stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "abcd1234-0000", cwd: www })) });
  const pid = () => pidIn(join(base, "daemon.pid"));
  const watch = () => { for (const f of ["daemon.pid", "usage.pid", "run-w1.pid", "test_p0/crew.pid"]) { const p = pidIn(join(base, f)); if (p) started.push(p); } };
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const helpers = () => { try { return JSON.parse(readFileSync(join(base, "daemon.helpers.json"), "utf8")); } catch { return null; } };
  return { dir, base, env, bin, daemon, ask, sidebar, pid, watch, lines, www, helpers };
}

// A copy of bin/, so touching its files leaves the repository's alone.
function binCopy() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sdbin-")));
  dirs.push(dir);
  const bin = join(dir, "bin");
  cpSync(join(root, "bin"), bin, { recursive: true });
  rmSync(join(bin, "__pycache__"), { recursive: true, force: true });
  return bin;
}

// The ps states (Z: a zombie) of pid's children whose command line holds text.
const children = (pid: number, text: string) => Bun.spawnSync(["ps", "-A", "-o", "ppid=,stat=,args="]).stdout.toString()
  .split("\n").map((l) => l.trim().split(/\s+/)).filter(([ppid, , ...args]) => Number(ppid) === pid && args.join(" ").includes(text)).map(([, stat]) => stat);

describe("the daemon", () => {
  test("two started at once leave one, which answers /ping with its pid", async () => {
    const s = await setup();
    const [a, b] = [s.daemon(), s.daemon()];
    const loser = await Promise.race([a.exited.then(() => a), b.exited.then(() => b)]);
    expect(loser.exitCode).toBe(0);
    const winner = loser === a ? b : a;
    expect(s.pid()).toBe(winner.pid);
    expect(s.ask("/ping")).toEqual({ pid: winner.pid });
    expect(winner.exitCode).toBe(null);
  });

  test("five started at once, twenty times over, always leave exactly one, and nothing in its log", async () => {
    for (let round = 0; round < 20; round++) {
      const s = await setup();
      const all = [1, 2, 3, 4, 5].map(() => s.daemon());
      const winner = await until(() => { const live = all.filter((p) => p.exitCode === null); return live.length === 1 && live[0]; }, 8000);
      expect(winner && winner.pid).toBe(s.pid());
      expect(s.ask("/ping")).toEqual({ pid: s.pid() });
      for (const p of all) if (p !== winner) expect(p.exitCode).toBe(0);
      expect(existsSync(join(s.base, "daemon.log"))).toBe(false);
      expect(require("node:fs").readdirSync(s.base).filter((f: string) => f.startsWith("daemon.pid."))).toEqual([]); // no pid file of its own left
      for (const p of all) try { p.kill(9); } catch {}
    }
  }, 60000);

  test("a pane that names a folder above the state dirs, a body too big, or a NUL is refused; the daemon goes on", async () => {
    const s = await setup();
    s.daemon();
    await until(() => s.pid() && s.ask("/ping").pid);
    for (const pane of [".", ".."]) {
      expect(s.ask("/start", { kind: "crew", args: [pane, "/x"] }).failed).toContain("400");
      expect(s.ask("/start", { kind: "run", args: [pane, "w1", s.www, "0"] }).failed).toContain("400");
    }
    expect(s.ask("/start", { kind: "crew", args: ["test:p0", "/x\u0000y"] }).failed).toContain("400");
    // A 50 MB body is refused from its header alone, at once, not read first.
    const big = Bun.spawnSync(["python3", "-I", "-c", `import socket, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[1])
s.sendall(b"POST /start HTTP/1.0\\r\\nContent-Length: 50000000\\r\\n\\r\\n")
print(s.recv(100).split(b"\\r\\n")[0].decode())`, join(s.base, "daemon.sock")]);
    expect(big.stdout.toString()).toStartWith("HTTP/1.0 413 "); // (its phrase differs between Pythons)
    expect(s.ask("/ping")).toEqual({ pid: s.pid() });
  }, 15000);

  test("the sidebar starts it with both helpers; killed with -9, the next sidebar run brings all back", async () => {
    const s = await setup();
    s.sidebar();
    s.watch();
    const first = await until(() => s.pid() && pidIn(join(s.base, "usage.pid")) === s.pid() && pidIn(join(s.base, "run-w1.pid")) === s.pid() && s.pid());
    expect(first).toBeGreaterThan(0);
    // both helpers report: $usage on the pane, $wsrun on the workspace
    expect(await until(() => s.lines().some((l) => l.includes('"pane.report_metadata"') && l.includes("steading-usage")))).toBe(true);
    expect(await until(() => s.lines().some((l) => l.includes('"workspace.report_metadata"') && l.includes("1 job")))).toBe(true);
    process.kill(first, "SIGKILL");
    await until(() => !alive(first));
    const asked = s.lines().length;
    s.sidebar();
    s.watch();
    const second = await until(() => s.pid() !== first && s.pid() && pidIn(join(s.base, "usage.pid")) === s.pid() && pidIn(join(s.base, "run-w1.pid")) === s.pid() && s.pid());
    expect(second).toBeGreaterThan(0);
    expect(second).not.toBe(first);
    expect(s.ask("/ping")).toEqual({ pid: second });
    expect(await until(() => s.lines().length > asked + 2)).toBe(true); // the helpers ask herdr again
    // Asked again, a helper that runs is not started twice.
    expect(s.ask("/start", { kind: "usage", args: [] })).toEqual({ state: "running" });
  }, 20000);

  test("a standalone helper exits at once when the daemon holds its pid file", async () => {
    const s = await setup();
    s.daemon();
    await until(() => s.pid() && s.ask("/ping").pid);
    expect(s.ask("/start", { kind: "usage", args: [] })).toEqual({ state: "started" });
    expect(s.ask("/start", { kind: "run", args: ["test:p0", "w1", s.www, "0"] })).toEqual({ state: "started" });
    for (const [script, args, file] of [["usage.py", [], "usage.pid"], ["steading_run.py", ["test:p0", "w1", s.www, "0"], "run-w1.pid"]] as const) {
      const p = Bun.spawn(["python3", "-I", join(s.bin, script), ...args], { env: s.env, stdout: "ignore", stderr: "ignore" });
      started.push(p.pid);
      expect(await Promise.race([p.exited, Bun.sleep(3000).then(() => -1)])).toBe(0);
      expect(pidIn(join(s.base, file))).toBe(s.pid());
    }
  }, 15000);

  test("a helper that raises is logged and ends; the daemon still answers, and the next /start runs it again", async () => {
    const s = await setup();
    s.daemon(["HERDR_SOCKET_PATH"]); // usage reaches for herdr's socket: KeyError
    await until(() => s.pid() && s.ask("/ping").pid);
    expect(s.ask("/start", { kind: "usage", args: [] })).toEqual({ state: "started" });
    const log = join(s.base, "daemon.log");
    expect(await until(() => existsSync(log) && readFileSync(log, "utf8").includes("KeyError: 'HERDR_SOCKET_PATH'"))).toBe(true);
    expect(s.ask("/ping")).toEqual({ pid: s.pid() });
    expect(await until(() => !existsSync(join(s.base, "usage.pid")))).toBe(true); // given back as it ended
    expect(await until(() => JSON.stringify(s.helpers()) === "[]")).toBe(true); // and no longer to restart
    expect(s.ask("/start", { kind: "usage", args: [] })).toEqual({ state: "started" });
    // A request that names no helper is refused, and the daemon goes on.
    expect(s.ask("/start", { kind: "run", args: ["test:p0"] }).failed).toContain("400");
    expect(s.ask("/nothing").failed).toContain("404");
    expect(s.ask("/ping")).toEqual({ pid: s.pid() });
  }, 15000);

  test("a touched steadingd.py re-execs it: the same pid, its socket bound again", async () => {
    const s0 = await setup();
    const bin = join(s0.dir, "bin"); // a copy, so the repository's file is left alone
    cpSync(join(root, "bin"), bin, { recursive: true });
    rmSync(join(bin, "__pycache__"), { recursive: true, force: true });
    const s = await setup({ bin });
    s.daemon();
    const pid = await until(() => s.pid() && s.ask("/ping").pid);
    const sock = join(s.base, "daemon.sock");
    const was = statSync(sock);
    const later = Date.now() / 1000 + 5;
    utimesSync(join(bin, "steadingd.py"), later, later);
    expect(await until(() => { try { const now = statSync(sock); return now.ino !== was.ino || now.birthtimeMs !== was.birthtimeMs; } catch { return false; } })).toBe(true);
    expect(await until(() => s.ask("/ping").pid)).toBe(pid);
    expect(s.pid()).toBe(pid);
  }, 15000);

  test("its helpers run again after a re-exec, and after kill -9 once it is started again", async () => {
    const s = await setup({ bin: binCopy() });
    writeFileSync(join(s.base, "test_p0", "main-busy"), ""); // the main agent's turn runs: the crew spins
    s.daemon();
    const first = await until(() => s.pid() && s.ask("/ping").pid);
    const crew = { kind: "crew", args: ["test:p0", join(s.dir, "subagents")] };
    const run = { kind: "run", args: ["test:p0", "w1", s.www, "0"] };
    for (const h of [{ kind: "usage", args: [] }, run, crew]) expect(s.ask("/start", h)).toEqual({ state: "started" });
    expect(s.helpers()).toEqual([{ kind: "usage", args: [] }, run, crew].map((h) => [h.kind, h.args]));
    const sock = join(s.base, "daemon.sock");
    const bound = statSync(sock);
    const later = Date.now() / 1000 + 5;
    utimesSync(join(s.bin, "steadingd.py"), later, later);
    expect(await until(() => { try { const now = statSync(sock); return now.ino !== bound.ino || now.birthtimeMs !== bound.birthtimeMs; } catch { return false; } })).toBe(true);
    // Re-exec'd, it holds every pid file again and runs each: asked, each is "running", not started anew.
    const crewPid = join(s.base, "test_p0", "crew.pid");
    expect(await until(() => s.ask("/ping").pid)).toBe(first);
    expect(s.ask("/start", { kind: "usage", args: [] })).toEqual({ state: "running" });
    expect(s.ask("/ping")).toEqual({ pid: first });
    expect(s.ask("/start", run)).toEqual({ state: "running" });
    expect(s.ask("/start", crew)).toEqual({ state: "running" });
    process.kill(first, "SIGKILL");
    await until(() => !alive(first));
    s.daemon();
    s.watch();
    const second = await until(() => s.pid() !== first && s.pid() && s.ask("/ping").pid);
    expect(second).not.toBe(first);
    for (const f of ["usage.pid", "run-w1.pid", "test_p0/crew.pid"]) expect(await until(() => pidIn(join(s.base, f)) === second)).toBe(true);
    expect(s.ask("/start", crew)).toEqual({ state: "running" });
    expect(pidIn(crewPid)).toBe(second);
  }, 30000);

  test("the crew spins in the daemon: one per pane, a standalone one exits, and it ends once none works", async () => {
    const s = await setup();
    const busy = join(s.base, "test_p0", "main-busy");
    writeFileSync(busy, "");
    s.daemon();
    await until(() => s.pid() && s.ask("/ping").pid);
    const crew = { kind: "crew", args: ["test:p0", join(s.dir, "subagents")] };
    expect(s.ask("/start", crew)).toEqual({ state: "started" });
    expect(s.ask("/start", crew)).toEqual({ state: "running" });
    const crewPid = join(s.base, "test_p0", "crew.pid");
    expect(pidIn(crewPid)).toBe(s.pid());
    // It spins at its 8 frames a second, each report lapsing in 3 s.
    const spins = () => s.lines().filter((l) => l.includes('"pane.report_metadata"') && l.includes("steading-crew") && l.includes('"crew": "')).length;
    const before = spins();
    await Bun.sleep(1000);
    const frames = spins() - before;
    expect(frames).toBeGreaterThanOrEqual(5);
    expect(frames).toBeLessThanOrEqual(9);
    expect(s.lines().some((l) => l.includes("steading-crew") && l.includes('"ttl_ms": 3000'))).toBe(true);
    const p = Bun.spawn(["python3", "-I", join(s.bin, "crew"), ...crew.args], { env: s.env, stdout: "ignore", stderr: "ignore" });
    started.push(p.pid);
    expect(await Promise.race([p.exited, Bun.sleep(3000).then(() => -1)])).toBe(0);
    expect(pidIn(crewPid)).toBe(s.pid());
    rmSync(busy); // the turn is over: the token is cleared, the thread ends and gives its pid file back
    expect(await until(() => !existsSync(crewPid), 4000)).toBe(true);
    expect(s.lines().at(-1)).toContain('"crew": null');
    expect(s.helpers()).toEqual([]);
    // A request for a crew that names no folder is refused.
    expect(s.ask("/start", { kind: "crew", args: ["test:p0"] }).failed).toContain("400");
  }, 15000);

  test("a deck on the System tab has the daemon sample: system.json comes fresh, macmon runs under it, and both stop once none asks", async () => {
    const s = await setup();
    const tools = join(s.dir, "tools");
    mkdirSync(tools);
    writeFileSync(join(tools, "macmon"), `#!/bin/sh\nwhile :; do echo '{"all_power": 1}'; sleep 0.2; done\n`);
    chmodSync(join(tools, "macmon"), 0o755);
    s.env.PATH = `${tools}:${s.env.PATH}`;
    // A deck names its project's servers for the daemon to mark.
    writeFileSync(join(s.base, "test_p0", "system.servers"), JSON.stringify([["3000", String(process.pid), "bun test"]]));
    const daemon = s.daemon();
    await until(() => s.pid() && s.ask("/ping").pid);
    const want = join(s.base, "system.want");
    const shared = join(s.base, "system.json");
    const touch = () => { writeFileSync(want, ""); writeFileSync(join(s.base, "test_p0", "system.servers"), JSON.stringify([["3000", String(process.pid), "bun test"]])); };
    touch();
    const toucher = setInterval(touch, 1000);
    try {
      const t0 = Date.now();
      expect(await until(() => existsSync(shared), 4500)).toBe(true); // within 2 * SAMPLE_SECS
      expect(Date.now() - t0).toBeLessThan(4500);
      const [stats] = JSON.parse(readFileSync(shared, "utf8"));
      expect(stats.cpu).toBeGreaterThanOrEqual(0);
      expect(stats.ports).toEqual({ [String(process.pid)]: "3000" });
      // A sample every SAMPLE_SECS.
      const was = statSync(shared).mtimeMs;
      expect(await until(() => statSync(shared).mtimeMs > was, 3500)).toBe(true);
      if (process.platform === "darwin") expect(await until(() => children(daemon.pid, "macmon pipe").length === 1)).toBe(true);
    } finally {
      clearInterval(toucher);
    }
    // No deck asks: within 5 s the want is stale, the thread ends, macmon is killed and reaped.
    expect(await until(() => children(daemon.pid, "macmon pipe").length === 0 && Date.now() - statSync(shared).mtimeMs > 2500, 10000)).toBe(true);
    const last = statSync(shared).mtimeMs;
    await Bun.sleep(2500);
    expect(statSync(shared).mtimeMs).toBe(last);
    expect(s.ask("/ping")).toEqual({ pid: s.pid() });
  }, 30000);

  test("a deck draws the daemon's fresh sample and takes none; with a daemon it waits for one; with none it samples as before", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sdsys-")));
    dirs.push(dir);
    const base = join(dir, "steading", "test_p0");
    mkdirSync(base, { recursive: true });
    const r = Bun.spawnSync(["python3", "-I", "-c", `import json, os, sys, time, types, importlib.util as u
sys.argv = ["v", sys.argv[1]]
spec = u.spec_from_file_location("v", ${JSON.stringify(join(root, "bin/viewer.py"))})
m = u.module_from_spec(spec); spec.loader.exec_module(m)
calls = []
m.background = lambda fn, *a: calls.append(fn.__name__)
top = os.path.dirname(m.BASE)
def deck(found=()):
    return m.System(types.SimpleNamespace(found=list(found)))
out = {}
# none: the deck samples at once, as before the daemon
s = deck(); s.share(); out["none"] = calls[:]; del calls[:]
# a live daemon, no sample yet: the deck waits for it, touching system.want and naming its servers
open(os.path.join(top, "daemon.pid"), "w").write(str(os.getpid()))
s = deck([("3000", "1", "node")]); s.share()
out["daemon"] = [calls[:], os.path.exists(os.path.join(top, "system.want")), json.load(open(os.path.join(m.BASE, "system.servers")))]
del calls[:]
# the daemon's sample, fresh (the election alone, no grace): drawn, no sample taken
os.remove(os.path.join(top, "daemon.pid"))
with open(m.SHARED, "w") as f:
    json.dump([{"cpu": 42.0, "have": [], "procs": {}}, None], f)
s = deck(); s.share(); out["fresh"] = [calls[:], s.stats.get("cpu")]
print(json.dumps(out))`, base], { env: { PATH: process.env.PATH! } });
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toEqual({ none: ["sample"], daemon: [[], true, [["3000", "1", "node"]]], fresh: [[], 42] });
  });

  test("when it cannot start (a socket path too long to bind), the sidebar runs the helpers as their own processes", async () => {
    const s = await setup({ tmp: "t".repeat(90) });
    expect(join(s.base, "daemon.sock").length).toBeGreaterThan(104);
    s.sidebar();
    s.watch();
    const owner = (file: string) => {
      const p = pidIn(join(s.base, file));
      return p && Bun.spawnSync(["ps", "-o", "args=", "-p", String(p)]).stdout.toString();
    };
    expect(await until(() => owner("usage.pid"))).toContain("usage.py");
    expect(await until(() => owner("run-w1.pid"))).toContain("steading_run.py");
    s.watch();
    expect(s.pid()).toBe(0); // the daemon gave its pid file back
    expect(readFileSync(join(s.base, "daemon.log"), "utf8")).toContain("AF_UNIX path too long");
  }, 15000);
});

// bin/sidebar hands its event to the daemon (curl over daemon.sock), or runs the scripts itself.
// The fake herdr CLI logs every call (and waits while <dir>/hold exists); the Python the scripts
// run on is a wrapper that logs what it runs, so a test sees which way an event went. No herdr
// socket: no helpers start, and only the hook's own work shows.
async function hookSetup(opts: { bin?: string } = {}) {
  const s = await setup(opts);
  const cli = join(s.dir, "herdr-cli");
  writeFileSync(cli, `#!/bin/sh\nwhile [ -e ${s.dir}/hold ]; do sleep 0.05; done\necho "$@" >> ${s.dir}/calls\n` +
    `[ "$1 $2" = "pane get" ] && echo '{"result":{"pane":{"workspace_id":"w1","tab_id":"w1:t1"}}}'\nexit 0\n`);
  const wrap = join(s.dir, "python");
  writeFileSync(wrap, `#!/bin/sh\necho "$*" >> ${s.dir}/py.log\nexec ${Bun.which("python3")} "$@"\n`);
  for (const f of [cli, wrap]) chmodSync(f, 0o755);
  delete s.env.HERDR_SOCKET_PATH;
  Object.assign(s.env, { HERDR_BIN_PATH: cli, STEADING_PYTHON: wrap });
  const hook = (event: object, env = s.env) => Bun.spawnSync([join(s.bin, "sidebar")], { env, cwd: s.www, stdin: Buffer.from(JSON.stringify(event)) });
  const ran = (script: string) => (existsSync(join(s.dir, "py.log")) ? readFileSync(join(s.dir, "py.log"), "utf8") : "").split("\n").filter((l) => l.includes(script)).length;
  const calls = () => (existsSync(join(s.dir, "calls")) ? readFileSync(join(s.dir, "calls"), "utf8").trim().split("\n").filter(Boolean) : []);
  const records = (sid = "S") => (existsSync(join(s.base, "sessions", `${sid}.log`)) ? readFileSync(join(s.base, "sessions", `${sid}.log`), "utf8").trim().split("\n").filter(Boolean) : []);
  const up = async () => { s.daemon(); s.watch(); return await until(() => s.pid() && s.ask("/ping").pid); };
  // Until the work after the hook is done: no sidebar.py runs, and the herdr calls have stopped for 500 ms.
  const settle = async () => {
    let n = -1, at = Date.now();
    for (;;) {
      const m = calls().length;
      if (m !== n || Bun.spawnSync(["pgrep", "-f", join(s.bin, "sidebar.py")]).exitCode === 0) [n, at] = [m, Date.now()];
      if (Date.now() - at > 500) return;
      await Bun.sleep(50);
    }
  };
  return { ...s, cli, hook, ran, calls, records, up, settle };
}

// The final states bin/subagents.py reads from the session's log.
const finalStates = (bin: string, base: string, sid = "S") => JSON.parse(Bun.spawnSync(["python3", "-I", "-c", `import json, sys
sys.path.insert(0, sys.argv[1])
import subagents
print(json.dumps({a: s for a, (s, t) in (subagents.states(sys.argv[2], sys.argv[3]) or {}).items()}))`, bin, base, sid]).stdout.toString());

describe("the sidebar hook through the daemon", () => {
  test("it reports what the scripts report, event for event, and runs no Python", async () => {
    const run = async (daemon: boolean) => {
      const s = await hookSetup();
      if (daemon) expect(await s.up()).toBeGreaterThan(0);
      const repo = join(s.dir, "repo");
      Bun.spawnSync(["git", "init", "-q", repo]);
      writeFileSync(join(repo, "a.txt"), "x");
      const transcript = join(s.dir, "s1.jsonl");
      const usage = (input: number) => JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(),
        message: { id: `m${input}`, model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: input, cache_read_input_tokens: 0, output_tokens: 10 } } });
      writeFileSync(transcript, [usage(1000), usage(170000)].join("\n") + "\n");
      const tasks = join(s.dir, ".claude", "tasks", "session-abcd1234");
      mkdirSync(tasks, { recursive: true });
      ["completed", "in_progress", "pending"].forEach((status, i) => writeFileSync(join(tasks, `${i + 1}.json`), JSON.stringify({ status })));
      const event = { hook_event_name: "PostToolUse", session_id: "abcd1234-0000", cwd: repo, transcript_path: transcript };
      const steps: [object, (() => void)?][] = [
        [event], [event], [{ ...event, agent_id: "sub" }], [{ ...event, hook_event_name: "UserPromptSubmit" }],
        [{ ...event, hook_event_name: "Stop" }],
        [{ ...event, hook_event_name: "Stop" }, () => writeFileSync(join(tasks, "3.json"), JSON.stringify({ status: "completed" }))],
        [{ ...event, hook_event_name: "Stop" }],
        [{ ...event, hook_event_name: "SessionStart", source: "startup" }, () => rmSync(join(s.base, "test_p0", "sidebar"))],
        [{ ...event, hook_event_name: "PostToolUse", tool_name: "TaskUpdate" }],
      ];
      const marks: string[] = [];
      for (const [e, before] of steps) {
        before?.();
        expect(s.hook(e).exitCode).toBe(0);
        await s.settle();
        marks.push(["main-busy", "sidebar", "crew"].map((f) => existsSync(join(s.base, "test_p0", f))).join(" "));
      }
      return { calls: s.calls().map((c) => c.split(s.dir).join("<dir>")), marks, records: s.records("abcd1234-0000").map((l) => l.split(" ").slice(1).join(" ")),
        python: s.ran("sidebar.py") + s.ran("subagents.py") };
    };
    const script = await run(false);
    const daemon = await run(true);
    expect(script.python).toBe(10); // SessionStart runs both
    expect(daemon.python).toBe(0);
    expect(script.calls.length).toBeGreaterThan(4);
    expect(daemon).toEqual({ ...script, python: 0 });
  }, 60000);

  test("a burst of 20 subagents starting and 10 stopping ends in the same states as through the scripts, each recorded once", async () => {
    const burst = async (daemon: boolean) => {
      const s = await hookSetup();
      if (daemon) expect(await s.up()).toBeGreaterThan(0);
      const one = (agent: number) => new Promise<void>((done) => {
        const go = (name: string, then: () => void) => {
          const p = Bun.spawn([join(s.bin, "sidebar")], { env: s.env, cwd: s.www, stdin: new Blob([JSON.stringify({ hook_event_name: name, session_id: "S", agent_id: `a${agent}` })]) });
          p.exited.then(then);
        };
        go("SubagentStart", () => (agent < 10 ? go("SubagentStop", done) : done()));
      });
      await Promise.all([...Array(20).keys()].map(one));
      return { states: finalStates(s.bin, s.base), lines: s.records().length, python: s.ran("subagents.py") };
    };
    const expected = Object.fromEntries([...Array(20).keys()].map((i) => [`a${i}`, i < 10 ? "done" : "working"]));
    const script = await burst(false);
    expect(script).toEqual({ states: expected, lines: 30, python: 30 });
    const daemon = await burst(true);
    expect(daemon).toEqual({ states: expected, lines: 30, python: 0 });
  }, 60000);

  test("the subagent's line is written when the hook returns", async () => {
    const s = await hookSetup();
    await s.up();
    for (let i = 0; i < 10; i++) {
      s.hook({ hook_event_name: "SubagentStart", session_id: "S", agent_id: `a${i}` });
      expect(s.records().length).toBe(i + 1);
    }
    expect(s.ran("subagents.py")).toBe(0);
  }, 15000);

  test("a daemon killed between two events, curl missing, or a daemon too busy (503): the scripts run, nothing lost or twice", async () => {
    const s = await hookSetup();
    const first = await s.up();
    s.hook({ hook_event_name: "SubagentStart", session_id: "S", agent_id: "a1" });
    expect([s.records().length, s.ran("subagents.py")]).toEqual([1, 0]);
    process.kill(first, "SIGKILL");
    await until(() => !alive(first));
    expect(existsSync(join(s.base, "daemon.sock"))).toBe(true); // left behind: curl is refused
    s.hook({ hook_event_name: "SubagentStart", session_id: "S", agent_id: "a2" });
    expect([s.records().length, s.ran("subagents.py")]).toEqual([2, 1]);
    // curl missing: a PATH with bash and cat, no curl
    await s.up();
    s.hook({ hook_event_name: "SubagentStart", session_id: "S", agent_id: "a3" }, { ...s.env, PATH: "/bin" });
    expect([s.records().length, s.ran("subagents.py")]).toEqual([3, 2]);
    s.hook({ hook_event_name: "SubagentStart", session_id: "S", agent_id: "a4" });
    expect([s.records().length, s.ran("subagents.py")]).toEqual([4, 2]);
    // 503: herdr hangs, so the worker holds a Stop, and 200 subagents' starts wait behind it.
    writeFileSync(join(s.dir, "hold"), "");
    const fill = Bun.spawnSync(["python3", "-I", "-c", `import json, socket, sys
codes = []
for i in range(201):
    body = json.dumps({"hook_event_name": "SubagentStart", "session_id": "F", "agent_id": f"f{i}"} if i else
                      {"hook_event_name": "Stop", "session_id": "S", "cwd": sys.argv[3]}).encode()
    c = socket.socket(socket.AF_UNIX); c.settimeout(2); c.connect(sys.argv[1])
    c.sendall(b"POST /hook/sidebar HTTP/1.0\\r\\nEnv: HERDR_ENV=1\\r\\nEnv: HERDR_PANE_ID=test:p0\\r\\nEnv: HERDR_BIN_PATH=" + sys.argv[2].encode() +
              b"\\r\\nContent-Length: " + str(len(body)).encode() + b"\\r\\n\\r\\n" + body)
    codes.append(c.recv(100).split(b" ")[1].decode()); c.close()
print(" ".join(sorted(set(codes))), codes.count("200"))`, join(s.base, "daemon.sock"), s.cli, s.www]);
    expect(fill.stdout.toString().trim()).toBe("200 201");
    expect(s.records("F").length).toBe(200);
    const busy = Bun.spawnSync(["python3", "-I", "-c", `import socket, sys
c = socket.socket(socket.AF_UNIX); c.settimeout(2); c.connect(sys.argv[1])
c.sendall(b"POST /hook/sidebar HTTP/1.0\\r\\nContent-Length: 2\\r\\n\\r\\n{}")
print(c.recv(100).split(b" ")[1].decode())`, join(s.base, "daemon.sock")]);
    expect(busy.stdout.toString().trim()).toBe("503");
    s.hook({ hook_event_name: "SubagentStart", session_id: "S", agent_id: "a5" });
    expect([s.records().length, s.ran("subagents.py")]).toEqual([5, 3]);
    expect(finalStates(s.bin, s.base)).toEqual({ a1: "working", a2: "working", a3: "working", a4: "working", a5: "working" });
    // Let go, the queue drains in order: a Stop handed over now reaches herdr after the held one.
    rmSync(join(s.dir, "hold"));
    const asked = () => s.calls().filter((c) => c.startsWith("pane get")).length;
    expect(await until(() => asked() === 1)).toBe(true);
    await Bun.sleep(300);
    s.hook({ hook_event_name: "Stop", session_id: "S", cwd: s.www });
    expect(await until(() => asked() === 2)).toBe(true);
    expect(s.ran("sidebar.py")).toBe(3); // the three that fell back (a2, a3, a5), not the last Stop
    expect(existsSync(join(s.base, "daemon.log"))).toBe(false);
  }, 60000);

  test("a hook that hung up before its turn came is dropped: it ran the scripts itself", async () => {
    const s = await hookSetup();
    const pid = await s.up();
    process.kill(pid, "SIGSTOP"); // busy
    try {
      const r = Bun.spawnSync(["python3", "-I", "-c", `import json, os, signal, socket, sys
for agent in ("gone", "kept"):
    body = json.dumps({"hook_event_name": "SubagentStart", "session_id": "S", "agent_id": agent}).encode()
    c = socket.socket(socket.AF_UNIX); c.settimeout(3); c.connect(sys.argv[1])
    c.sendall(b"POST /hook/sidebar HTTP/1.0\\r\\nContent-Length: " + str(len(body)).encode() + b"\\r\\n\\r\\n" + body)
    if agent == "gone":
        c.close()
os.kill(int(sys.argv[2]), signal.SIGCONT)
print(c.recv(100).split(b" ")[1].decode())`, join(s.base, "daemon.sock"), String(pid)]);
      expect(r.stdout.toString().trim()).toBe("200");
    } finally {
      process.kill(pid, "SIGCONT");
    }
    expect(finalStates(s.bin, s.base)).toEqual({ kept: "working" });
  }, 15000);

  test("a bad body is refused (400); a re-exec first finishes the events it accepted", async () => {
    const s = await hookSetup({ bin: binCopy() });
    const pid = await s.up();
    const bad = Bun.spawnSync(["python3", "-I", "-c", `import socket, sys
for body in (b"[1]", b"{nope"):
    c = socket.socket(socket.AF_UNIX); c.settimeout(2); c.connect(sys.argv[1])
    c.sendall(b"POST /hook/sidebar HTTP/1.0\\r\\nContent-Length: " + str(len(body)).encode() + b"\\r\\n\\r\\n" + body)
    print(c.recv(100).split(b" ")[1].decode())`, join(s.base, "daemon.sock")]);
    expect(bad.stdout.toString().split("\n").filter(Boolean)).toEqual(["400", "400"]);
    writeFileSync(join(s.dir, "hold"), "");
    for (let i = 0; i < 3; i++) s.hook({ hook_event_name: "Stop", session_id: "S", cwd: s.www });
    expect(s.ran("sidebar.py")).toBe(0);
    const sock = join(s.base, "daemon.sock");
    const bound = statSync(sock);
    const later = Date.now() / 1000 + 5;
    utimesSync(join(s.bin, "steadingd.py"), later, later);
    await Bun.sleep(1500);
    expect(statSync(sock).ino).toBe(bound.ino); // it waits for the worker
    rmSync(join(s.dir, "hold"));
    expect(await until(() => { try { return statSync(sock).ino !== bound.ino; } catch { return false; } })).toBe(true);
    expect(await until(() => s.ask("/ping").pid)).toBe(pid);
    expect(s.calls().filter((c) => c.startsWith("pane get")).length).toBe(3);
  }, 30000);
});
