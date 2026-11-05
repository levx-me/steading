import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(import.meta.dir, "..");

const PYLOAD = `import importlib.util, sys
from importlib.machinery import SourceFileLoader
def load(name, path):
    loader = SourceFileLoader(name, path)
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
    sys.modules[name] = mod
    loader.exec_module(mod)
    return mod`;

const PARENT = "11111111-aaaa-4aaa-8aaa-111111111111";
const CHILD = "22222222-bbbb-4bbb-8bbb-222222222222";

// A parent session in a config folder, a crew run it started (its transcript running a command, one
// subagent of its own), and run records that are not its: another parent's, one with no parent, one
// of its own whose process died long ago. A fake wanjang status gives the crew run's subagent a time.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "steading-crew-"));
  const proj = join(dir, "projects", "-repo");
  const runs = join(dir, "wanjang", "crew-console", "runs");
  mkdirSync(join(proj, CHILD, "subagents"), { recursive: true });
  mkdirSync(runs, { recursive: true });
  const at = new Date(Date.now() - 60_000).toISOString();
  const now = Math.floor(Date.now() / 1000);
  const main = join(proj, `${PARENT}.jsonl`);
  writeFileSync(main, JSON.stringify({ type: "user", timestamp: at, message: { content: "hi" } }) + "\n");
  writeFileSync(join(proj, `${CHILD}.jsonl`), [
    { type: "user", timestamp: at, message: { content: "Fix the login bug" } },
    { type: "assistant", timestamp: at, message: { model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test", description: "Run the login tests" } }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const subs = join(proj, CHILD, "subagents");
  writeFileSync(join(subs, "agent-w1.meta.json"), JSON.stringify({ description: "Find the login calls", agentType: "wanjang:scout", spawnDepth: 1 }));
  writeFileSync(join(subs, "agent-w1.jsonl"), JSON.stringify({ type: "user", timestamp: at, message: { content: "go" } }) + "\n");
  const rec = (sid: string, parent: string, extra: object) =>
    writeFileSync(join(runs, `${sid}.json`), JSON.stringify({ session_id: sid, parent_session_id: parent, agent: "builder", model: "default",
      effort: "", title: "Fix the login bug", cwd: "/repo", started: now - 60, status: "running", cost_usd: 0, log: "/x", ...extra }));
  const dead = Bun.spawnSync(["true"]).pid;
  rec(CHILD, PARENT, { pid: process.pid });
  rec("33333333-cccc-4ccc-8ccc-333333333333", "someone-else", { pid: process.pid, title: "Other parent" });
  rec("44444444-dddd-4ddd-8ddd-444444444444", "", { pid: process.pid, title: "No parent" });
  rec("55555555-eeee-4eee-8eee-555555555555", PARENT, { pid: dead, title: "Killed long ago" });
  const quiet = join(proj, "55555555-eeee-4eee-8eee-555555555555.jsonl");
  writeFileSync(quiet, JSON.stringify({ type: "user", timestamp: at, message: { content: "x" } }) + "\n");
  utimesSync(quiet, now - 1000, now - 1000);
  const fake = join(dir, "status");
  writeFileSync(fake, `#!/usr/bin/env python3
import json, sys, time
now = time.time()
if "${CHILD}" in sys.argv[-1]:
    print(json.dumps(dict(agents=[dict(id="w1", started=now - 60, eta=dict(likely=now + 240, latest=now + 400))], eta_all=now + 300)))
else:
    print(json.dumps(dict(agents=[], eta_all=None)))
`);
  chmodSync(fake, 0o755);
  return { dir, main, runs, rec, now };
}

// Draws the list, then (the second step) after the crew run's record says it ended.
const check = `
import json, os, sys, time
${PYLOAD}
v = load("v", sys.argv[1])
v.background = lambda fn, *a: fn(*a)  # inline, for the test
v.wake = lambda: None
v.herdr_api = lambda *a, **k: {}
v.SHOWN["kind"] = "agents"
s = v.Agents(); s.kept = (None, time.time() + 3600, sys.argv[2], "")
def draw():
    s.looked = 0
    s.refresh(); s.refresh()
    print("== " + v.ANSI.sub("", s.run_list(80)[0]))
    for line in s.rows(80):
        print(v.ANSI.sub("", line).rstrip())
    crew = next((r for r in s.every if isinstance(r, v.CrewRun) and r.id == "${CHILD}"), None)
    print("info " + (v.ANSI.sub("", crew.info()).strip() if crew else "-"))
    print("ids " + " ".join(sorted(r.id for r in s.every)))
draw()
rec = json.load(open(sys.argv[3]))
rec.update(status="done", exit=0, ended=int(time.time()), cost_usd=0.4213)
json.dump(rec, open(sys.argv[3], "w"))
os.utime(sys.argv[3], (time.time() + 5, time.time() + 5))
s.eta_at = time.time()  # no new times asked
draw()
`;

describe("a crew-console run the shown session started is listed like a subagent", () => {
  test("its type, brief, what it does, api tag, its own subagent under it, a countdown; ended: its result and cost", () => {
    const t = setup();
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), t.main, join(t.runs, `${CHILD}.json`)], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(t.dir, "base"), CLAUDE_CONFIG_DIR: t.dir, STEADING_WANJANG_STATUS: join(t.dir, "status") },
    });
    expect(r.stderr.toString()).toBe("");
    const [running, done] = r.stdout.toString().split("== ").slice(1);
    const lines = running.split("\n");
    // Only its own run, with its subagent: not another parent's, not one with no parent, not one dead long ago.
    expect(running).not.toContain("Other parent");
    expect(running).not.toContain("No parent");
    expect(running).not.toContain("Killed long ago");
    expect(running).toMatch(new RegExp(`ids ${CHILD} .*w1`)); // (the dead one is read, not listed)
    const crew = lines.findIndex((l) => l.includes("wanjang:builder"));
    expect(lines[crew]).toMatch(/wanjang:builder\s+Run the login tests\s+sonnet-5-5$/);
    expect(lines[crew + 1]).toMatch(/Fix the login bug\s+api  ▕.*▏  0[45]:\d\d$/);
    expect(lines[crew + 2]).toMatch(/└ wanjang:scout/); // its own subagent, under it
    expect(lines[crew + 3]).toMatch(/Find the login calls\s+api  ▕.*▏  0[34]:\d\d$/); // its worker bills to the API key too
    expect(running).toContain("info wanjang:builder · on the API key · 1 tool call");
    // Ended: still listed, done, its cost on its second row and in its detail.
    const after = done.split("\n");
    const row = after.findIndex((l) => l.includes("wanjang:builder"));
    expect(after[row]).toMatch(/✓\s+wanjang:builder/);
    expect(after[row + 1]).toMatch(/Fix the login bug\s+api  \$0\.42  1m( \ds)?$/);
    expect(done).toContain("info wanjang:builder · on the API key · $0.42 · 1 tool call");
  });

  test("a run whose process is gone and whose transcript is quiet is stopped", () => {
    const t = setup();
    const code = `
${PYLOAD}
v = load("v", sys.argv[1])
s = v.Agents()
rec = [r for r in v.crew_runs("${PARENT}") if r["session_id"].startswith("5555")][0]
print(v.CrewRun(v.crew_transcript(rec["session_id"]), s, rec).activity())`;
    const r = Bun.spawnSync(["python3", "-I", "-c", code, join(root, "bin/viewer.py")], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(t.dir, "base"), CLAUDE_CONFIG_DIR: t.dir },
    });
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim()).toBe("stopped");
  });
});
