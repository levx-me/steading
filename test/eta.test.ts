import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(import.meta.dir, "..");

// Python snippets load a bin/ file by path: the old loader method is gone in Python 3.15.
const PYLOAD = `import importlib.util, sys
from importlib.machinery import SourceFileLoader
def load(name, path):
    loader = SourceFileLoader(name, path)
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
    sys.modules[name] = mod
    loader.exec_module(mod)
    return mod`;

// A session with three subagents at work, and a fake wanjang status that answers with $FAKE_ETA
// (times relative to now) and logs each call's arguments.
function session() {
  const dir = mkdtempSync(join(tmpdir(), "steading-eta-"));
  const main = join(dir, "s1.jsonl");
  const subs = join(dir, "s1", "subagents");
  mkdirSync(subs, { recursive: true });
  const at = new Date(Date.now() - 60_000).toISOString();
  for (const [id, desc] of [["q1", "QA re-check"], ["p1", "PM iPhone app"], ["c1", "checker"]]) {
    writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify({ description: desc, agentType: "wanjang:x", toolUseId: `t${id}`, spawnDepth: 1 }));
    writeFileSync(join(subs, `agent-${id}.jsonl`), JSON.stringify({ type: "user", timestamp: at, message: { content: "go" } }) + "\n");
  }
  writeFileSync(main, JSON.stringify({ type: "user", timestamp: at, message: { content: "hi" } }) + "\n");
  const fake = join(dir, "status");
  writeFileSync(fake, `#!/usr/bin/env python3
import json, os, sys, time
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(" ".join(sys.argv[1:]) + "\\n")
spec = json.loads(os.environ["FAKE_ETA"])
if spec.get("fail"):
    sys.exit(1)
now = time.time()
rel = lambda v: None if v is None else now + v
agents = [dict(id=i, started=now + e.pop("started"), eta=dict(likely=rel(e.pop("likely", None)), latest=rel(e.pop("latest", None)), **e))
          for i, e in spec["agents"].items()]
print(json.dumps(dict(agents=agents, eta_all=rel(spec.get("eta_all")))))
`);
  chmodSync(fake, 0o755);
  return { dir, main, fake, log: join(dir, "calls.log") };
}

// Each step: the fake's answer, then the list drawn at the given width (plain text).
const check = `
import json, os, sys, time
${PYLOAD}
v = load("v", sys.argv[1])
v.background = lambda fn, *a: fn(*a)  # inline, for the test
v.wake = lambda: None
v.SHOWN["kind"] = "agents"
s = v.Agents(); s.session, s.looked = sys.argv[2], time.time()
s.read_main(); s.refresh()
for step in json.loads(sys.argv[3]):
    os.environ["FAKE_ETA"] = json.dumps(step["eta"])
    s.eta_at -= step.get("later", 0)
    s.refresh()
    s.list_rows = step.get("list_rows", 10)
    print("== " + v.ANSI.sub("", s.run_list(step.get("cols", 70))[0]))
    for line in s.rows(step.get("cols", 70)):
        print(v.ANSI.sub("", line).rstrip())
`;

function run(steps: object[], env: Record<string, string> = {}) {
  const t = session();
  const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), t.main, JSON.stringify(steps)], {
    env: { PATH: process.env.PATH!, STEADING_BASE: join(t.dir, "base"), STEADING_WANJANG_STATUS: t.fake, FAKE_LOG: t.log, ...env },
  });
  expect(r.stderr.toString()).toBe("");
  let calls: string[] = [];
  try {
    calls = readFileSync(t.log, "utf8").trim().split("\n");
  } catch {}
  return { out: r.stdout.toString(), calls, main: t.main };
}

const ETA = {
  eta_all: 700,
  agents: {
    q1: { started: -300, likely: 300, latest: 600 }, // halfway: half a bar, 05:00 to go
    p1: { started: -600, likely: 700, latest: 900, tasks_done: 2, tasks_total: 4 }, // a PM's run-log tasks
    c1: { started: -900, likely: -130, latest: -130 }, // past its latest: full, +02:10
  },
};

describe("the agents list counts down to wanjang's finish times", () => {
  test("a bar and a countdown on each agent's second row, the overall time on the border; status asked once per 30s", () => {
    const { out, calls, main } = run([{ eta: ETA }, { eta: ETA, later: 10 }]);
    const [first] = out.split("== ").slice(1);
    const lines = first.split("\n");
    expect(lines[0]).toMatch(/^╭─ agents · 4 ─+ ~\d\d:\d\d · 11:(39|40) left ─╮$/);
    const row = (given: string) => lines.find((l) => l.includes(given))!;
    expect(row("QA re-check")).toMatch(/▕█████░░░░░▏  0[45]:[0-9]{2}$/);
    expect(row("PM iPhone app")).toMatch(/▰▰▱▱▱ 2\/4  ▕█████░░░░░▏  11:[34]\d$/);
    expect(row("checker")).toMatch(/▕██████████▏ \+02:1[01]$/);
    // One call: the second refresh came 10s later, inside the 30s.
    expect(calls).toEqual([`--eta --json --session ${main}`]);
  });

  test("past the likely end the bar is full and counts to the latest; over every past run the held times keep counting", () => {
    const later = { eta_all: 60, agents: { q1: { started: -300, likely: -10, latest: 120 }, c1: { started: -900, over: true } } };
    const over = { agents: { q1: { started: -300, over: true } } };
    const { out, calls } = run([{ eta: later }, { eta: over, later: 31 }]);
    const [a, b] = out.split("== ").slice(1);
    expect(a.split("\n").find((l) => l.includes("QA re-check"))).toMatch(/▕██████████▏  0[12]:\d\d$/);
    expect(a.split("\n").find((l) => l.includes("checker"))).toMatch(/▕██████████▏   over$/); // over, no time ever held
    expect(b.split("\n").find((l) => l.includes("QA re-check"))).toMatch(/▕██████████▏  0[12]:\d\d$/); // kept from the call before
    expect(b.split("\n")[0]).not.toContain("left"); // no eta_all: nothing on the border
    expect(calls.length).toBe(2);
  });

  test("a narrow deck drops the bar and keeps the countdown; a short one puts the countdown beside the model", () => {
    const { out } = run([{ eta: ETA, cols: 40 }, { eta: ETA, list_rows: 4 }]);
    const [narrow, short] = out.split("== ").slice(1);
    const q = narrow.split("\n").find((l) => l.includes("QA re"))!;
    expect(q).toMatch(/ 0[45]:\d\d$/);
    expect(q).not.toContain("▕");
    expect(short).not.toContain("QA re-check"); // no second rows
    expect(short).toMatch(/ 0[45]:\d\d\n/);
  });

  test("no wanjang, or its status failing: no countdown, the age as before", () => {
    for (const [steps, env] of [[[{ eta: ETA }], { STEADING_WANJANG_STATUS: "" }], [[{ eta: { fail: true } }], {}]] as const) {
      const { out } = run(steps as object[], env as Record<string, string>);
      expect(out).not.toContain("▕");
      expect(out).not.toContain("left");
      expect(out.split("\n").find((l) => l.includes("QA re-check"))).toMatch(/1m( \d+s)?$/);
    }
  });
});
