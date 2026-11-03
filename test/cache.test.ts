import { describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bin/transcripts.py keeps what a deck parsed of a transcript: one cache file per transcript,
// keyed by the parser's source (transcripts.py and bin/classify), not by the deck's drawing.
const bin = join(import.meta.dir, "../bin");
const OTHER = "/opt/homebrew/bin/python3"; // a second interpreter (3.15 here), beside the system's 3.9
const line = (o: object) => JSON.stringify(o) + "\n";
const at = "2026-01-01T00:00:00Z";
const result = (id: string) => line({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id }] } });
const call = (id: string) => line({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: "/a" } }] } });
const note = (id: string) => line({ type: "queue-operation", timestamp: at, content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` });

// One deck's read of a main transcript to its end, in a fresh process: through the deck
// (viewer.py's Agents) or through transcripts.py alone. Prints the rows it parsed and the state.
const DRIVER = `
import importlib.util, json, os, sys, time
from importlib.machinery import SourceFileLoader
mode, folder, path, chunk = sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
sys.path.insert(0, folder)
import transcripts as t
if chunk:
    t.CHUNK = chunk
n = [0]; loads = json.loads
def counted(raw, *a, **k):
    n[0] += isinstance(raw, bytes)
    return loads(raw, *a, **k)
json.loads = counted
if mode == "deck":
    loader = SourceFileLoader("viewer", os.path.join(folder, "viewer.py"))
    v = importlib.util.module_from_spec(importlib.util.spec_from_loader("viewer", loader))
    loader.exec_module(v)
    s = v.Agents(); s.session = path
    step, state = s.read_main, s.__dict__
else:
    state = {"read_to": 0, "digest": t.Digest(), "results": {}, "notified": {}, "notified_at": {}, "stamps": []}
    step = lambda: t.read_main(path, state)
while True:  # one chunk a read: read on to the end, as a deck's ticks do
    was = state["read_to"]; step()
    if state["read_to"] == was:
        break
print(json.dumps({"parsed": n[0], "read_to": state["read_to"], "results": state["results"],
                  "notified": state["notified"], "called": sorted(state["digest"].called), "cache": t.CACHE}))
`;

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "steading-parser-cache-"));
  const main = join(dir, "s1.jsonl");
  writeFileSync(main, call("c1") + result("c1") + note("bbb") + call("c2") + result("c2"));
  writeFileSync(join(dir, "driver.py"), DRIVER);
  return { dir, main, cache: join(dir, "cache") };
};

type Opts = { py?: string; mode?: "deck" | "parser"; folder?: string; chunk?: number; env?: Record<string, string> };
const read = (dir: string, main: string, cache: string | null, o: Opts = {}) => {
  const env: Record<string, string> = { PATH: process.env.PATH!, HOME: join(dir, "home"), ...(o.env || {}) };
  if (cache) env.STEADING_CACHE = cache;
  const r = Bun.spawnSync([o.py || "python3", "-I", join(dir, "driver.py"), join(dir, "base"), o.mode || "parser",
    o.folder || bin, main, String(o.chunk || 0)], { env });
  expect(r.stderr.toString()).toBe("");
  return JSON.parse(r.stdout.toString());
};
// A copy of bin/ to edit: the real files stay as they are.
const binCopy = (dir: string) => {
  const copy = join(dir, "bin");
  cpSync(bin, copy, { recursive: true, filter: (p) => !p.includes("__pycache__") });
  return copy;
};

describe("the parse cache", () => {
  test("outlives an edit to the deck's drawing (viewer.py), read through the deck", () => {
    const { dir, main, cache } = setup();
    const copy = binCopy(dir);
    const first = read(dir, main, cache, { mode: "deck", folder: copy });
    expect(first.parsed).toBe(5);
    appendFileSync(join(copy, "viewer.py"), "\n# a colour changed\n");
    appendFileSync(main, result("c3"));
    const again = read(dir, main, cache, { mode: "deck", folder: copy });
    expect(again.parsed).toBe(1); // only the row added since
    expect(Object.keys(again.results).sort()).toEqual(["c1", "c2", "c3"]);
    expect(again.notified).toEqual({ bbb: "done" });
  });

  test("is dropped by an edit to the parser (transcripts.py, bin/classify or bin/subagents.py)", () => {
    for (const file of ["transcripts.py", "classify", "subagents.py"]) {
      const { dir, main, cache } = setup();
      const copy = binCopy(dir);
      read(dir, main, cache, { folder: copy });
      appendFileSync(join(copy, file), "\n# the parser changed\n");
      expect({ file, parsed: read(dir, main, cache, { folder: copy }).parsed }).toEqual({ file, parsed: 5 });
    }
  });

  test("keeps the end a long catch-up reached, not an early chunk (a restart then reads nothing)", () => {
    const { dir, main, cache } = setup();
    // Read in chunks shorter than a line: five reads within the 20 s between throttled saves.
    expect(read(dir, main, cache, { chunk: 10 }).parsed).toBe(5);
    const again = read(dir, main, cache, { chunk: 10 });
    expect(again.parsed).toBe(0);
    expect(again.read_to).toBe(readFileSync(main).length);
  });

  test("is not used for a transcript cut short: parsed from the start", () => {
    const { dir, main, cache } = setup();
    read(dir, main, cache);
    truncateSync(main, (call("c1") + result("c1")).length);
    const again = read(dir, main, cache);
    expect(again.parsed).toBe(2);
    expect(again.called).toEqual(["c1"]);
    expect(again.notified).toEqual({});
  });

  test("is not used for a new file at the same path (rotation): parsed from the start", () => {
    const { dir, main, cache } = setup();
    read(dir, main, cache);
    // The same bytes and more: only its inode tells it from the old file grown.
    writeFileSync(join(dir, "new"), readFileSync(main, "utf8") + call("n1"));
    renameSync(join(dir, "new"), main);
    const again = read(dir, main, cache);
    expect(again.parsed).toBe(6);
    expect(again.called).toEqual(["c1", "c2", "n1"]);
  });

  test("a corrupt or an empty cache file means a full parse, not an error", () => {
    for (const bytes of ["\x00garbage\xff not a pickle", ""]) {
      const { dir, main, cache } = setup();
      read(dir, main, cache);
      for (const f of readdirSync(cache)) writeFileSync(join(cache, f), bytes);
      const again = read(dir, main, cache); // read() demands an empty stderr
      expect({ bytes, parsed: again.parsed }).toEqual({ bytes, parsed: 5 });
      expect(again.called).toEqual(["c1", "c2"]);
    }
  });

  test("holds plain data only: no class is named in the file", () => {
    const { dir, main, cache } = setup();
    read(dir, main, cache);
    const [file] = readdirSync(cache);
    const r = Bun.spawnSync(["python3", "-I", "-c", `import pickletools, sys
data = open(sys.argv[1], "rb").read()
ops = {op.name for op, _, _ in pickletools.genops(data)}
print(sorted(ops & {"GLOBAL", "STACK_GLOBAL", "INST", "OBJ", "REDUCE", "NEWOBJ", "NEWOBJ_EX"}), data[1])`,
      join(cache, file)]);
    expect(r.stdout.toString().trim()).toBe("[] 4"); // no class; pickle protocol 4 (its PROTO byte)
  });

  test.skipIf(!existsSync(OTHER) || !existsSync("/usr/bin/python3"))(
    "written by one Python and read by the other, both ways", () => {
      for (const [writer, reader] of [[OTHER, "/usr/bin/python3"], ["/usr/bin/python3", OTHER]]) {
        const { dir, main, cache } = setup();
        expect(read(dir, main, cache, { py: writer }).parsed).toBe(5);
        appendFileSync(main, result("c3"));
        const again = read(dir, main, cache, { py: reader });
        expect({ writer, parsed: again.parsed }).toEqual({ writer, parsed: 1 });
        expect(again.called).toEqual(["c1", "c2"]);
      }
    });

  test("prune removes a file untouched for over 14 days and keeps a fresh one", () => {
    const { dir, cache } = setup();
    mkdirSync(cache);
    writeFileSync(join(cache, "old"), "x");
    writeFileSync(join(cache, "fresh"), "x");
    const days = (n: number) => (Date.now() - n * 86400_000) / 1000;
    utimesSync(join(cache, "old"), days(15), days(15));
    utimesSync(join(cache, "fresh"), days(13), days(13));
    const r = Bun.spawnSync(["python3", "-I", "-c", `import sys; sys.path.insert(0, sys.argv[1]); import transcripts; transcripts.prune()`, bin],
      { env: { PATH: process.env.PATH!, STEADING_CACHE: cache } });
    expect(r.stderr.toString()).toBe("");
    expect(readdirSync(cache)).toEqual(["fresh"]);
  });

  test("prune of a cache folder not made yet does nothing", () => {
    const { dir } = setup();
    const r = Bun.spawnSync(["python3", "-I", "-c", `import sys; sys.path.insert(0, sys.argv[1]); import transcripts; transcripts.prune()`, bin],
      { env: { PATH: process.env.PATH!, STEADING_CACHE: join(dir, "none") } });
    expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
  });

  test("lives in ~/.cache/steading without STEADING_CACHE, or under XDG_CACHE_HOME when set", () => {
    const { dir, main } = setup();
    const home = read(dir, main, null); // HOME is dir/home
    expect(home.cache).toBe(join(dir, "home", ".cache", "steading"));
    expect(readdirSync(home.cache).length).toBe(1);
    const xdg = read(dir, main, null, { env: { XDG_CACHE_HOME: join(dir, "xdg") } });
    expect(xdg.cache).toBe(join(dir, "xdg", "steading"));
    expect(xdg.parsed).toBe(5); // a cache folder of its own
  });
});
