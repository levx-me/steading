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
  const watch = () => { for (const f of ["daemon.pid", "usage.pid", "run-w1.pid"]) { const p = pidIn(join(base, f)); if (p) started.push(p); } };
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  return { dir, base, env, bin, daemon, ask, sidebar, pid, watch, lines, www };
}

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
