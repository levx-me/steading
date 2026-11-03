import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
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
