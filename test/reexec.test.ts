import { expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(import.meta.dir, "../bin");

test("reexec.watcher re-execs once the helper's file changes, with the same argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "reexec-"));
  const script = join(dir, "helper.py");
  writeFileSync(script, `import sys
sys.path.insert(0, ${JSON.stringify(bin)})
import os, reexec
calls = []
check = reexec.watcher(__file__, every=0, exec_=lambda *a: calls.append(a))
check(); assert not calls, "unchanged file must not re-exec"
os.utime(__file__, (1, 1))
check()
exe, argv = calls[0]
assert exe == os.path.join(os.path.dirname(os.path.abspath(reexec.__file__)), "py"), exe
assert argv == [exe, "-I", os.path.abspath(__file__), "x", "y"], argv
print("ok")
`);
  const r = Bun.spawnSync(["python3", "-I", script, "x", "y"]);
  expect(r.stderr.toString()).toBe("");
  expect(r.stdout.toString().trim()).toBe("ok");
});
