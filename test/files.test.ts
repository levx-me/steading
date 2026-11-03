import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(import.meta.dir, "../bin");

// Run python in a fresh interpreter with bin/ on the path; prints JSON.
function py(code: string) {
  const r = Bun.spawnSync(["python3", "-I", "-c", `import sys, json\nsys.path.insert(0, ${JSON.stringify(bin)})\n${code}`]);
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout.toString());
}

const post = (tool: string, input: unknown, extra: object = {}) =>
  ({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: tool, tool_input: input, ...extra });

const sub = { agent_id: "ag1", agent_type: "wanjang scout" };
const events = [
  post("Read", { file_path: "/a/r.ts" }),
  post("Edit", { file_path: "/a/e.ts" }),
  post("Write", { file_path: "/a/w with space.ts" }),
  post("NotebookEdit", { notebook_path: "/a/n.ipynb" }),
  post("Read", { file_path: "/a/e.ts" }, sub),
  post("Read", { file_path: "/a/sub.ts" }, sub),
];
const junk = [
  post("Read", {}),
  post("Read", { file_path: "/a/x\ny" }),
  post("Grep", { file_path: "/a/g" }),
  post("Read", "str"),
  { ...post("Read", { file_path: "/a/p" }), hook_event_name: "PreToolUse" },
  { ...post("Read", { file_path: "/a/nosid" }), session_id: "" },
];

describe("files.record and files.states", () => {
  test("records reads and writes, main and subagent; W sticks; junk ignored", () => {
    const root = mkdtempSync(join(tmpdir(), "files-"));
    const out = py(`
import files
root, n = ${JSON.stringify(root)}, 100
for e in ${JSON.stringify([...events, ...junk])}:
    n += 1
    files.record(root, e, n)
print(json.dumps(files.states(root, "s1")))`);
    expect(out).toEqual({
      "/a/r.ts": ["R", "-", "main", 101],
      "/a/e.ts": ["W", "ag1", "wanjang_scout", 105],
      "/a/w with space.ts": ["W", "-", "main", 103],
      "/a/n.ipynb": ["W", "-", "main", 104],
      "/a/sub.ts": ["R", "ag1", "wanjang_scout", 106],
    });
    expect(readFileSync(join(root, "sessions/s1.files"), "utf8").trim().split("\n").length).toBe(events.length);
  });

  test("states is None without a file, reads incrementally, waits for a half-written line", () => {
    const root = mkdtempSync(join(tmpdir(), "files-"));
    const out = py(`
import files
root = ${JSON.stringify(root)}
a = files.states(root, "s1")
files.record(root, ${JSON.stringify(events[0])}, 5)
p = files.files_path(root, "s1")
open(p, "a").write("9 - main W /half")
b = files.states(root, "s1")
open(p, "a").write("\\n")
c = files.states(root, "s1")
print(json.dumps([a, b, c]))`);
    expect(out[0]).toBeNull();
    expect(out[1]).toEqual({ "/a/r.ts": ["R", "-", "main", 5] });
    expect(out[2]["/half"]).toEqual(["W", "-", "main", 9]);
  });

  test("sidebar.run records (outside herdr too) and never raises", () => {
    const root = mkdtempSync(join(tmpdir(), "files-"));
    const out = py(`
import os, sidebar, files
env = {"TMPDIR": ${JSON.stringify(root)}}
sidebar.run(${JSON.stringify(events[1])}, env)
sidebar.run(${JSON.stringify(events[4])}, env)
sidebar.run({"hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": 5}, env)
print(json.dumps(files.states(os.path.join(env["TMPDIR"], "steading"), "s1")))`);
    expect(out["/a/e.ts"].slice(0, 3)).toEqual(["W", "ag1", "wanjang_scout"]);
  });

  test("bin/files.py as a script records stdin and survives garbage", () => {
    const root = mkdtempSync(join(tmpdir(), "files-"));
    const run = (input: string) =>
      Bun.spawnSync(["python3", "-I", join(bin, "files.py")], { stdin: Buffer.from(input), env: { PATH: process.env.PATH!, TMPDIR: root } });
    expect(run(JSON.stringify(events[0])).exitCode).toBe(0);
    expect(run("not json").exitCode).toBe(0);
    expect(readFileSync(join(root, "steading/sessions/s1.files"), "utf8")).toMatch(/^\d+ - main R \/a\/r\.ts\n$/);
  });
});

describe("the deck's files tab", () => {
  // A repository with a changed file, a new one (a space and é in its name) and one read; a file
  // outside it; one written then deleted. The record says who touched each; ag1 is at work.
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "files-tab-"));
    const repo = join(dir, "repo"), base = join(dir, "st", "agent");
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.email=a@example.com", "-c", "user.name=a", ...a]);
    mkdirSync(join(repo, "src/lib"), { recursive: true });
    mkdirSync(join(repo, "test"), { recursive: true });
    mkdirSync(base, { recursive: true });
    mkdirSync(join(dir, "out"));
    writeFileSync(join(repo, "src/lib/x.py"), "a\nb\n");
    writeFileSync(join(repo, "test/t.ts"), "r\n");
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "init");
    writeFileSync(join(repo, "src/lib/x.py"), "a\nc\nd\n");
    writeFileSync(join(repo, "new file é.md"), "1\n2\n3\n");
    writeFileSync(join(dir, "out/notes.txt"), "far away\n");
    writeFileSync(join(base, "root"), repo);
    mkdirSync(join(dir, "st", "sessions"));
    const now = Date.now() * 1e6;
    writeFileSync(join(dir, "st/sessions/sid.files"), [
      `${now - 9e9} - main R ${join(repo, "test/t.ts")}`,
      `${now - 8e9} ag1 wanjang:builder W ${join(repo, "src/lib/x.py")}`,
      `${now - 7e9} - main W ${join(repo, "new file é.md")}`,
      `${now - 6e9} - main R ${join(dir, "out/notes.txt")}`,
      `${now - 5e9} - main W ${join(repo, "gone.txt")}`,
    ].join("\n") + "\n");
    return { dir, repo, base };
  };
  // bin/viewer.py loaded on that base, its threads run inline, the files tab shown.
  const deck = (base: string, body: string, env: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["python3", "-I", "-c", `import sys, json, os, time, types, importlib.util as u
sys.argv = ["v", ${JSON.stringify(base)}]
spec = u.spec_from_file_location("v", ${JSON.stringify(join(bin, "viewer.py"))})
m = u.module_from_spec(spec); spec.loader.exec_module(m)
m.background = lambda fn, *a: fn(*a)
m.SHOWN["kind"] = "files"
agents = types.SimpleNamespace(session="/p/sid.jsonl", agent_status="", records={"ag1": ("working", 1)})
f = m.Files(agents)
plain = lambda lines: [m.ANSI.sub("", l).replace(m.SPIN_MARK, "*").rstrip() for l in lines]
${body}`], { env: { PATH: process.env.PATH!, HOME: "/nonexistent", ...env } });
    expect(r.stderr.toString()).toBe("");
    return JSON.parse(r.stdout.toString());
  };

  test("a tree from the repository's root: folders first, one-folder chains on one row, outside files under their folder", () => {
    const { dir, base } = setup();
    const rows = deck(base, `f.refresh()
print(json.dumps(plain(f.rows(90))))`);
    const names = ["▾ src/lib/", "✎   x.py", "▾ test/", "◦   t.ts", "✎ gone.txt", "✎ new file é.md", `▾ ${join(dir, "out")}/`, "◦   notes.txt"];
    expect(rows.map((r: string, i: number) => r.slice(2, 2 + (names[i] ?? "").length))).toEqual(names);
    expect(rows[1]).toMatch(/\* editing builder \+2 -1 8s ago$/);  // ag1 works: editing now; the plugin: prefix dropped
    expect(rows[5]).toMatch(/✓ main \+3 new 7s ago$/);              // new to git: its lines, as added
    expect(rows[4]).toMatch(/✓ main deleted 5s ago$/);              // gone: no counts
    expect(rows[3]).toMatch(/\s main 9s ago$/);                     // a read: no state, no counts
    expect(rows[7]).toMatch(/\s main 6s ago$/);
  });

  test("reads are dimmed, writes bright; the main agent's writes are being edited while it works, done after", () => {
    const { base } = setup();
    const out = deck(base, `f.refresh(); f.tab = 0
raw = f.rows(90)
agents.agent_status = "working"; f.refresh(); busy = plain(f.rows(90))[5]
agents.agent_status = "idle"; agents.records = {"ag1": ("done", 2)}; f.refresh(); done = plain(f.rows(90))
dim, bright = m.fg(m.DIMMED_RGB), m.fg(m.BRIGHT_RGB)
print(json.dumps([dim + "  t.ts" in raw[3], bright + "  x.py" in raw[1], busy, done[1], done[5]]))`);
    expect(out[0]).toBe(true);
    expect(out[1]).toBe(true);
    expect(out[2]).toMatch(/\* editing main \+3 new/);
    expect(out[3]).toMatch(/✓ builder \+2 -1/);
    expect(out[4]).toMatch(/✓ main \+3 new/);
  });

  test("enter shows the diff (git diff HEAD, or the whole file as added), esc and q come back; y copies, o needs herdr", () => {
    const { repo, base } = setup();
    const out = deck(base, `copied = []; m.copy = copied.append
f.refresh()
def diff(row):
    f.focus = "list"; f.select(row); f.list_key("\\r")
    shown = plain(f.frame(90, 40)[0])
    return [f.focus, [l.strip("│ ") for l in shown if l.strip("│ ")[:1] in "+-@"]]
tracked, new, outside = diff(1), diff(5), diff(7)
f.key("\\x1b"); after_esc = f.focus
f.list_key("\\r"); f.key(m.back_key(f, "q")); after_q = f.focus
f.select(1); f.list_key("y"); f.list_key("o")
msg, hints = f.msg, f.hints()[:3]
f.select(0); f.list_key("\\r"); folder = f.focus
print(json.dumps([tracked, new, outside, after_esc, after_q, copied, msg, folder, hints]))`);
    expect(out[0][0]).toBe("log");
    expect(out[0][1]).toEqual(expect.arrayContaining(["-b", "+c", "+d"]));
    expect(out[1][1]).toEqual(expect.arrayContaining(["+1", "+2", "+3"]));
    expect(out[2][1]).toEqual(expect.arrayContaining(["+far away"]));
    expect(out[3]).toBe("list");
    expect(out[4]).toBe("list");
    expect(out[5]).toEqual([join(repo, "src/lib/x.py")]);
    expect(out[6]).toBe(`outside herdr: open ${join(repo, "src/lib/x.py")} in your editor`);
    expect(out[7]).toBe("list");  // a folder has no diff: enter folds it
    expect(out[8]).toEqual([["enter", "diff"], ["o", "edit"], ["y", "copy path"]]);
  });

  test("o in herdr opens $EDITOR on the file in a split below the deck", () => {
    const { repo, base } = setup();
    writeFileSync(join(base, "pane"), "w1:p2");
    const out = deck(base, `calls = []
m.herdr = lambda *a: (calls.append(list(a)), {"pane": {"pane_id": "w1:p9"}})[1]
f.refresh(); f.select(5); f.list_key("o")
print(json.dumps(calls))`, { HERDR_ENV: "1", EDITOR: "nvim -p" });
    expect(out[0].slice(0, 5)).toEqual(["pane", "split", "w1:p2", "--direction", "down"]);
    expect(out[1]).toEqual(["pane", "run", "w1:p9", `nvim -p '${join(repo, "new file é.md")}'`]);
  });

  test("git runs only while the tab shows, a second apart, and again only when a written file moved", () => {
    const { repo, base } = setup();
    const out = deck(base, `calls = []
git_out = m.git_out
m.git_out = lambda *a, **k: (calls.append(a[2] if len(a) > 2 else a), git_out(*a, **k))[1]
counts = []
m.SHOWN["kind"] = "git"; f.refresh(); counts.append([len(calls), len(f.runs)])
m.SHOWN["kind"] = "files"; f.refresh(); counts.append(len(calls))
f.read_at -= 5; f.refresh(); counts.append(len(calls))            # nothing moved: no git
f.read_at = time.time(); os.utime(${JSON.stringify(join(repo, "src/lib/x.py"))}, (1, 1)); f.refresh(); counts.append(len(calls))  # under a second
f.read_at -= 5; f.refresh(); counts.append(len(calls))            # a written file moved
print(json.dumps([counts, calls[:2]]))`);
    expect(out[0]).toEqual([[0, 0], 2, 2, 2, 4]);
    expect(out[1]).toEqual(["diff", "ls-files"]);  // one numstat, and ls-files for the written files it does not list
  });

  test("the tab is F (2, after agents), empty without a record, and lists the newest 500 of many", () => {
    const dir = mkdtempSync(join(tmpdir(), "files-tab-"));
    const base = join(dir, "st", "agent");
    mkdirSync(join(dir, "st", "sessions"), { recursive: true });
    mkdirSync(base);
    const out = deck(base, `d = m.Deck(); d.key("F"); tab = m.SECTIONS[d.section]
d.key("1"); d.key("2"); two = m.SECTIONS[d.section]
keys = []
for k in "123456789":
    d.key(k); keys.append(m.SECTIONS[d.section])
empty, hints = plain(f.frame(80, 30)[0]), f.hints()
with open(${JSON.stringify(join(dir, "st/sessions/sid.files"))}, "w") as fh:
    for n in range(600):
        fh.write(f"{n + 1} - main W /far/f{n}.txt\\n")
f.refresh()
files = [r for r in f.runs if not r.folder]
print(json.dumps([tab, two, any("No files touched yet" in l for l in empty), len(files), files[0].name, plain(f.run_list(80))[0],
                  keys, [k for k, _ in hints]]))`);
    expect(out.slice(0, 5)).toEqual(["files", "files", true, 500, "f100.txt"]);
    expect(out[5]).toMatch(/files · 500 .*✎ 500 ◦ 0/);
    expect(out[6]).toEqual(["agents", "files", "jobs", "servers", "build", "test", "git", "deploy", "system"]);
    expect(out[7]).toEqual(["L", "[ ]", ",", "ctrl+c"]);  // nothing listed: no enter, o or y
  });

  test("enter (or l) on a folder folds it, ▸, its subtree hidden, kept across refreshes; again unfolds it", () => {
    const { base } = setup();
    const out = deck(base, `f.refresh(); names = lambda: [r.name for r in f.runs]
whole = names()
f.select(0); f.list_key("\\r"); folded, mark, hint = names(), plain(f.rows(90))[0][2:4], f.hints()[0]
f.shape = None; f.refresh(); kept = names()
f.list_key("l"); back, hint2 = names(), f.hints()[0]
print(json.dumps([whole, folded, mark, hint, kept, back, hint2, f.runs[0].count]))`);
    expect(out[1]).toEqual(out[0].filter((n: string) => n !== "x.py"));
    expect(out[2]).toBe("▸ ");
    expect(out[3]).toEqual(["enter", "unfold"]);
    expect(out[4]).toEqual(out[1]);   // built again, still folded
    expect(out[5]).toEqual(out[0]);
    expect(out[6]).toEqual(["enter", "fold"]);
    expect(out[7]).toBe(1);           // a folder counts its files, folded or not
  });

  test("narrow, the right side drops when, then who, then the lines; the name keeps 12 cells", () => {
    const { base } = setup();
    const out = deck(base, `f.refresh()
print(json.dumps([plain(f.rows(w))[1] for w in (90, 38, 30, 24)]))`);
    expect(out[0]).toMatch(/x\.py\s+\* editing builder \+2 -1 8s ago$/);
    expect(out[1]).toMatch(/x\.py\s+\* editing builder \+2 -1$/);
    expect(out[2]).toMatch(/x\.py\s+\* editing \+2 -1$/);
    expect(out[3]).toMatch(/x\.py\s+\* editing$/);
  });

  test("a word on the info line (herdr did not open a pane) goes when the tab is left or shown again", () => {
    const { base } = setup();
    const out = deck(base, `d = m.Deck(); f = d.views[1]; f.agents = agents
d.choose(1); d.refresh(); f.msg = "herdr did not open a pane"
d.choose(2); d.refresh(); left = f.msg
f.msg = "late"; d.choose(1); d.refresh(); back = f.msg
d.refresh(); f.msg = "stays"; d.refresh()
print(json.dumps([left, back, f.msg]))`);
    expect(out).toEqual(["", "", "stays"]);
  });
});
