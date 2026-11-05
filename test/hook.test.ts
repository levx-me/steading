import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const hook = join(root, "bin/hook");

// Python snippets load a bin/ file by path: the old loader method is gone in Python 3.15.
const PYLOAD = `import importlib.util, sys
from importlib.machinery import SourceFileLoader
def load(name, path):
    loader = SourceFileLoader(name, path)
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
    sys.modules[name] = mod
    loader.exec_module(mod)
    return mod`;

// Run bin/hook on a Bash tool call; returns the rewritten command or null.
function rewrite(command: string, env: Record<string, string> = {}) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command, description: "x" } });
  const r = Bun.spawnSync([hook], {
    stdin: Buffer.from(input),
    env: { PATH: process.env.PATH!, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", CLAUDE_PLUGIN_ROOT: root, ...env },
  });
  expect(r.exitCode).toBe(0);
  const out = r.stdout.toString().trim();
  if (!out) return null;
  const json = JSON.parse(out).hookSpecificOutput;
  expect(json.permissionDecision).toBe("allow");
  expect(json.updatedInput.description).toBe("x"); // other tool fields survive
  const [, kind, core = "", post = ""] = json.updatedInput.command.split(" ");
  const dec = (s: string) => (s === "-" ? "" : Buffer.from(s, "base64").toString());
  return { kind, core: dec(core), post: dec(post) };
}

describe("hook rewrites plain test runs", () => {
  const cases: [string, string, string][] = [
    ["npx vitest run", "npx vitest run", ""],
    ["npx jest --runInBand", "npx jest --runInBand", ""],
    ["pytest tests/ -x", "pytest tests/ -x", ""],
    ["python3 -m pytest -q", "python3 -m pytest -q", ""],
    ["cargo test --all", "cargo test --all", ""],
    ["cargo nextest run", "cargo nextest run", ""],
    ["go test ./...", "go test ./...", ""],
    ["bun test", "bun test", ""],
    ["deno test -A", "deno test -A", ""],
    ["forge test -vvv", "forge test -vvv", ""],
    ["forge test --match-contract SwapTest", "forge test --match-contract SwapTest", ""],
    ["cd contracts && forge test", "cd contracts && forge test", ""],
    ["FOUNDRY_PROFILE=ci forge test", "FOUNDRY_PROFILE=ci forge test", ""],
    ["pnpm test", "pnpm test", ""],
    ["npm run test 2>&1", "npm run test", ""],
    ["npm run test 2>&1 | tail -40", "npm run test", "tail -40"],
    ["npx jest | head -n 20", "npx jest", "head -n 20"],
    ["./test.sh", "./test.sh", ""],
    ["make test", "make test", ""],
    ["time forge test", "time forge test", ""],
    ["npm run test:unit", "npm run test:unit", ""],
  ];
  for (const [cmd, core, post] of cases) {
    test(cmd, () => expect(rewrite(cmd)).toEqual({ kind: "test", core, post }));
  }
});

describe("hook rewrites plain builds", () => {
  for (const cmd of [
    "forge build",
    "forge build --sizes",
    "cargo build --release",
    "cargo check",
    "go build ./...",
    "npx tsc --noEmit",
    "npx next build",
    "npm run build",
    "pnpm build",
    "cd web && bun run build",
    "./build.sh",
    "/usr/bin/time -p ./build.sh",
    "bash scripts/build-all.sh",
    "make build",
    "npm run build:prod",
    "timeout 600 forge build",
  ]) {
    test(cmd, () => expect(rewrite(cmd)).toEqual({ kind: "build", core: cmd, post: "" }));
  }
});

describe("hook passes the agent's description along as the run's label", () => {
  const label = (command: string, description: string) => {
    const r = Bun.spawnSync([hook], {
      stdin: Buffer.from(JSON.stringify({ tool_name: "Bash", tool_input: { command, description } })),
      env: { PATH: process.env.PATH!, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", CLAUDE_PLUGIN_ROOT: root },
    });
    const parts = JSON.parse(r.stdout.toString()).hookSpecificOutput.updatedInput.command.split(" ");
    expect(parts).toHaveLength(5); // run, kind, command, filter, label: none may vanish
    return parts[4] === "-" ? "" : Buffer.from(parts[4], "base64").toString();
  };
  test("kind prefix dropped", () => expect(label("forge test -vvv", "test: forge test -vvv")).toBe("forge test -vvv"));
  test("prose is not a label: the command is", () => expect(label("cd contracts && forge test", "Run the tests")).toBe("forge test"));
});

describe("hook leaves everything else alone", () => {
  for (const cmd of [
    "npm install && npm test",
    "forge test; rm -rf /",
    "pytest $(cat list)",
    "forge test `whoami`",
    "forge test > out.txt",
    "npm test | grep FAIL",
    "forge fmt",
    "./latest.sh",
    "./rebuild.sh",
    "make deploy",
    "echo vitest",
    'git commit -m "add test"',
    "vitest-like-tool run",
  ]) {
    test(cmd, () => expect(rewrite(cmd)).toBeNull());
  }

  test("outside herdr", () => expect(rewrite("forge test", { HERDR_ENV: "" })).toBeNull());
});

describe("hook does not rewrite dev servers (it only opens the servers pane)", () => {
  // CLAUDE_PLUGIN_ROOT points nowhere, so no pane is opened while testing.
  for (const cmd of ["npm run dev", "pnpm dev", "npx next dev -p 3950", "cd web && bun run dev", "anvil --port 8545", "npm start &"]) {
    test(cmd, () => expect(rewrite(cmd, { CLAUDE_PLUGIN_ROOT: "/nonexistent" })).toBeNull());
  }
});

describe("bin/run outside herdr runs the command directly", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const run = (cmd: string, post = "") =>
    Bun.spawnSync([join(root, "bin/run"), "test", b64(cmd), b64(post)], {
      env: { PATH: process.env.PATH!, HERDR_ENV: "" },
    });

  test("passes output (stderr included) and exit code through", () => {
    const r = run("echo hi; echo oops >&2; exit 3");
    expect(r.stdout.toString()).toBe("hi\noops\n");
    expect(r.exitCode).toBe(3);
  });

  test("an empty filter followed by a label does not run the label", () => {
    const r = Bun.spawnSync([join(root, "bin/run"), "test", b64("echo once"), "-", b64("echo twice")], {
      env: { PATH: process.env.PATH!, HERDR_ENV: "" },
    });
    expect(r.stdout.toString()).toBe("once\n");
  });

  test("applies the output filter and keeps the command's exit code", () => {
    const r = run("printf '1\\n2\\n3\\n'; exit 1", "tail -1");
    expect(r.stdout.toString()).toBe("3\n");
    expect(r.exitCode).toBe(1);
  });
});

describe("record keeps finished runs for the deck", () => {
  const { mkdtempSync, readFileSync, readdirSync, existsSync } = require("node:fs");
  const { tmpdir } = require("node:os");

  // Feed bin/record one hook event; returns the kind and run it wrote, or null.
  function record(event: object, env: Record<string, string> = {}) {
    const tmp = mkdtempSync(join(tmpdir(), "steading-"));
    const r = Bun.spawnSync([join(root, "bin/record")], {
      stdin: Buffer.from(JSON.stringify({ tool_name: "Bash", cwd: "/tmp", ...event })),
      // A dead socket keeps the test from opening a real herdr pane.
      env: { PATH: process.env.PATH!, TMPDIR: tmp, HERDR_ENV: "1", HERDR_PANE_ID: "w9:p9", HERDR_SOCKET_PATH: "/nonexistent", ...env },
    });
    expect(r.exitCode).toBe(0);
    for (const kind of ["test", "build", "git", "deploy"]) {
      const runs = join(tmp, "steading/w9_p9", kind, "runs");
      if (!existsSync(runs)) continue;
      const [n] = readdirSync(runs);
      const f = (name: string) => readFileSync(join(runs, n, name), "utf8").trim();
      const branch = existsSync(join(runs, n, "branch")) ? { branch: f("branch") } : {};
      return { kind, cmd: f("cmd"), log: f("log"), rc: f("rc"), cwd: f("cwd"), ...branch } as Record<string, string>;
    }
    return null;
  }
  const ok = (command: string, stdout = "", description?: string) =>
    record({ hook_event_name: "PostToolUse", tool_input: { command, description }, tool_response: { stdout, stderr: "" } });
  const labelOf = (description: string, command: string) => {
    const tmp = mkdtempSync(join(tmpdir(), "steading-"));
    Bun.spawnSync([join(root, "bin/record")], {
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: "/tmp",
        tool_input: { command, description }, tool_response: { stdout: "x" } })),
      env: { PATH: process.env.PATH!, TMPDIR: tmp, HERDR_ENV: "1", HERDR_PANE_ID: "w9:p9", HERDR_SOCKET_PATH: "/nonexistent" },
    });
    for (const kind of ["test", "build", "git", "deploy"]) {
      const f = join(tmp, "steading/w9_p9", kind, "runs/1/label");
      if (existsSync(f)) return { kind, label: readFileSync(f, "utf8").trim() };
    }
    return null;
  };

  test("a command with quotes, newlines and $() reaches the files as it was", () => {
    const command = "git commit -m \"it's $(echo hi)\n`ls`\" && echo '$HOME'";
    const r = ok(command, "out\nput");
    expect(r?.kind).toBe("git");
    expect(r?.cmd).toBe(command);
    expect(r?.log).toBe("out\nput");
  });

  test("a description in the note's format names the section and the label", () =>
    expect(labelOf("build: ./build.sh", "/usr/bin/time -p ./build.sh > /tmp/b.log 2>&1; git status --short"))
      .toEqual({ kind: "build", label: "./build.sh" }));

  test("the description wins over the command's own guess", () =>
    expect(labelOf("test: forge test --match-path 'test/*'", "git status -sb | head -1; forge test --match-path 'test/*' | grep FAIL"))
      .toEqual({ kind: "test", label: "forge test --match-path 'test/*'" }));

  test("vercel and railway go to deploy", () => {
    expect(ok("vercel --prod")?.kind).toBe("deploy");
    expect(ok("cd web && npx vercel deploy 2>&1 | tail -5")?.kind).toBe("deploy");
    expect(ok("railway up --detach")?.kind).toBe("deploy");
    expect(ok("echo vercel")).toBeNull();
  });

  test("vercel and railway that ship nothing stay out of deploy", () => {
    for (const cmd of ["vercel --version", "vercel ls --format json", "npx vercel logs x", "vercel env pull", "railway logs", "railway status"])
      expect(ok(cmd)).toBeNull();
    expect(ok("vercel ls", "", "deploy: vercel ls")).toBeNull(); // the description cannot make it one
    expect(ok("npm run build && vercel --prod", "", "deploy: vercel --prod")?.kind).toBe("deploy");
  });

  test("other deploy CLIs, by the subcommand that ships", () => {
    for (const cmd of ["netlify deploy --prod", "fly deploy", "npx wrangler deploy", "wrangler pages deploy dist",
      "firebase deploy --only hosting", "gcloud run deploy api --source .", "aws cloudformation deploy --template-file t.yml",
      "terraform apply -auto-approve", "kubectl apply -f k8s/", "helm upgrade --install api ./chart",
      "forge script script/Deploy.s.sol --rpc-url x --broadcast", "forge create src/A.sol:A",
      "npx hardhat ignition deploy ./m.ts", "git push heroku main", "pnpm dlx sst deploy", "gh-pages -d dist", "time kamal deploy"])
      expect(ok(cmd)?.kind).toBe("deploy");
    for (const cmd of ["netlify status", "wrangler dev", "gcloud run services list", "terraform plan", "kubectl get pods",
      "helm list", "forge script script/Deploy.s.sol", "supabase start", "sam --version"])
      expect(ok(cmd)).toBeNull();
    expect(ok("git push origin main")?.kind).toBe("git");
  }, 30_000); // 27 runs of bin/record: past bun's 5s default on a busy machine

  test("a deploy: description", () =>
    expect(labelOf("deploy: vercel --prod", "vercel --prod --yes 2>&1 | tail -3")).toEqual({ kind: "deploy", label: "vercel --prod" }));

  test("a free-form description falls back to the command for the kind, and still labels the run", () => {
    expect(ok("git push", "", "Push to origin")?.kind).toBe("git");
    expect(labelOf("Build giwaswap-status", 'cd x; pnpm build 2>&1 | grep -v "^$" | tail -25; echo "exit=$?"'))
      .toEqual({ kind: "build", label: "pnpm build" });
    expect(labelOf("Run tests", "git status -sb | head -1; forge test --match-path 'test/*' 2>&1 | grep FAIL"))
      .toEqual({ kind: "test", label: "forge test --match-path 'test/*'" });
  });

  test("a git: description on a read-only command is still skipped", () =>
    expect(ok("git status", "", "git: git status")).toBeNull());

  test("a successful git command", () => {
    expect(ok("git add -A", "")).toEqual({ kind: "git", cmd: "git add -A", log: "", rc: "0", cwd: "/tmp" });
  });

  test("a git run notes its branch: in the repo it cd's into, else its cwd", () => {
    const repo = mkdtempSync(join(tmpdir(), "steading-repo-"));
    Bun.spawnSync(["git", "init", "-q", "-b", "feature/x", repo]);
    const commit = (command: string, cwd: string) =>
      record({ hook_event_name: "PostToolUse", cwd, tool_input: { command }, tool_response: { stdout: "" } });
    expect(commit(`cd ${repo} && git commit -m "Fix"`, "/tmp")?.branch).toBe("feature/x");
    expect(commit('git commit -m "Fix"', repo)?.branch).toBe("feature/x");
    expect(commit('git commit -m "Fix"', "/tmp")?.branch).toBeUndefined(); // not a repo: no branch
  });

  test("read-only git is not recorded", () => {
    for (const c of ["git status --short", "git -C ~/repo log --oneline -5", "git diff --stat; git show HEAD", "git stash list",
                     "git branch -a", "git tag -l", "git remote -v", "git config --get user.name", "git fetch origin"]) {
      expect(ok(c, "x")).toBeNull();
    }
  });

  test("a chain with one write is recorded", () =>
    expect(ok("git status -sb; git add -A && git commit -m 'x'")?.kind).toBe("git"));

  test("write forms of branch, stash, tag, remote, config", () => {
    for (const c of ["git branch -D old", "git stash", "git stash pop", "git tag v1.0", "git remote add up x", "git config user.name x"]) {
      expect(ok(c)?.kind).toBe("git");
    }
  });

  test("a failed git command keeps its exit code and output", () => {
    const run = record({
      hook_event_name: "PostToolUseFailure",
      tool_input: { command: "cd repo && git push" },
      error: "Exit code 128\nfatal: no upstream",
    });
    expect(run).toEqual({ kind: "git", cmd: "cd repo && git push", log: "fatal: no upstream", rc: "128", cwd: "/tmp" });
  });

  test("git later in a chain", () => expect(ok("npm run lint && git add -A")?.kind).toBe("git"));

  test("a test run inside a chain and a pipe goes to test", () =>
    expect(ok("git status -sb | head -1; forge test --match-path 'test/*' 2>&1 | grep -E 'Suite result|FAIL'")?.kind).toBe("test"));

  test("a build piped through tail goes to build", () => expect(ok("forge build 2>&1 | tail -20")?.kind).toBe("build"));

  test("a timed build script with git status at the end goes to build", () =>
    expect(ok('/usr/bin/time -p ./build.sh > /tmp/build.log 2>&1; echo "exit $?"; grep -E "error|^real" /tmp/build.log | head -20; git status --short')?.kind).toBe("build"));

  test("a test run in a subshell", () => expect(ok("(cd contracts && forge test) | tail -5")?.kind).toBe("test"));

  test("quoted arguments do not hide the run", () =>
    expect(ok("forge test --match-path 'test/*' 2>&1 | grep -E \"Suite|FAIL\"")?.kind).toBe("test"));

  test("skips commands already routed through bin/run", () =>
    expect(ok(`"${root}/bin/run" test Zm9yZ2UgdGVzdA== `)).toBeNull());

  for (const command of [
    "ls", "echo git status", "gitk", "npx digit run", "echo forge test", "cat jest.config.js", "npm run testing",
    "grep 'forge test' notes.md",
    'sed -i "s/|bun run test/x/" README.md',
    "python3 - <<'PY'\nprint('ok')\n; forge test\nPY",
  ]) {
    test(`ignores: ${command}`, () => expect(ok(command, "x")).toBeNull());
  }

  test("a run sent to the background points at Claude's task output", () => {
    const { mkdirSync, writeFileSync } = require("node:fs");
    const tmp = mkdtempSync(join(tmpdir(), "steading-"));
    const uid = Bun.spawnSync(["id", "-u"]).stdout.toString().trim();
    const tasks = join(tmp, `claude-${uid}`, "project", "session", "tasks");
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, "bgtest123.output"), "Suite result: ok\n");
    const r = Bun.spawnSync([join(root, "bin/record")], {
      stdin: Buffer.from(JSON.stringify({
        hook_event_name: "PostToolUse", tool_name: "Bash", cwd: "/tmp",
        tool_input: { command: "forge test", run_in_background: true },
        tool_response: { stdout: "", stderr: "", backgroundTaskId: "bgtest123" },
      })),
      env: { PATH: process.env.PATH!, TMPDIR: tmp, HERDR_ENV: "1", HERDR_PANE_ID: "w9:p9", HERDR_SOCKET_PATH: "/nonexistent" },
    });
    expect(r.exitCode).toBe(0);
    const run = join(tmp, "steading/w9_p9/test/runs/1");
    expect(readFileSync(join(run, "source"), "utf8").trim()).toBe(join(tasks, "bgtest123.output"));
    expect(existsSync(join(run, "rc"))).toBe(false); // still running: no exit code yet
    expect(existsSync(join(run, "end"))).toBe(false);
  });

  test("ignores everything outside herdr", () =>
    expect(record({ hook_event_name: "PostToolUse", tool_input: { command: "git log" }, tool_response: { stdout: "x" } }, { HERDR_ENV: "" })).toBeNull());
});

describe("open tells the agent how to run things for the deck", () => {
  const open = (event: object, env: Record<string, string> = {}) =>
    Bun.spawnSync([join(root, "bin/open")], {
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "SessionStart", cwd: "/tmp", ...event })),
      // compact never opens the deck; the dead socket keeps tests off real herdr.
      env: { PATH: process.env.PATH!, HERDR_ENV: "1", HERDR_PANE_ID: "w9:p9", HERDR_SOCKET_PATH: "/nonexistent", ...env },
    });

  test("adds the note to the session", () => {
    const r = open({ source: "compact" });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()).hookSpecificOutput;
    expect(out.hookEventName).toBe("SessionStart");
    expect(out.additionalContext).toContain("plain commands");
  });

  test("says nothing outside herdr", () => expect(open({ source: "startup" }, { HERDR_ENV: "" }).stdout.toString()).toBe(""));

  test("says nothing to subagents", () => expect(open({ source: "startup", agent_id: "sub" }).stdout.toString()).toBe(""));
});

describe("restore refills an empty deck from the transcript", () => {
  const { mkdtempSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
  const { tmpdir } = require("node:os");

  test("tests, builds and git writes come back with output and exit code", () => {
    const tmp = mkdtempSync(join(tmpdir(), "steading-"));
    const use = (id: string, command: string, description: string, at: string) => ({
      type: "assistant", timestamp: at, cwd: "/tmp",
      message: { content: [{ type: "tool_use", id, name: "Bash", input: { command, description } }] },
    });
    const result = (id: string, content: string, at: string, is_error = false, toolUseResult?: object) => ({
      type: "user", timestamp: at, toolUseResult,
      message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
    });
    const transcript = join(tmp, "session.jsonl");
    writeFileSync(transcript, [
      use("a", "npm test", "test: npm test", "2026-01-01T00:00:00Z"),
      result("a", "Exit code 1\n1 failed", "2026-01-01T00:00:05Z", true),
      use("b", "git status", "Show status", "2026-01-01T00:01:00Z"), // read-only: left out
      result("b", "clean", "2026-01-01T00:01:01Z", false, { stdout: "clean", stderr: "" }),
      use("c", 'git commit -m "Fix"', 'git: git commit -m "Fix"', "2026-01-01T00:02:00Z"),
      result("c", "[main abc1234] Fix", "2026-01-01T00:02:01Z", false, { stdout: "[main abc1234] Fix", stderr: "" }),
    ].map((l) => JSON.stringify(l)).join("\n"));
    const r = Bun.spawnSync(["python3", "-I", join(root, "bin/restore"), transcript], {
      env: { PATH: process.env.PATH!, TMPDIR: tmp, HERDR_ENV: "1", HERDR_PANE_ID: "w9:p9", HERDR_SOCKET_PATH: "/nonexistent" },
    });
    expect(r.exitCode).toBe(0);
    const base = join(tmp, "steading/w9_p9");
    const f = (kind: string, name: string) => readFileSync(join(base, kind, "runs/1", name), "utf8").trim();
    expect(readdirSync(base).sort()).toEqual(["git", "test"]);
    expect([f("test", "rc"), f("test", "log"), f("test", "end")]).toEqual(["1", "1 failed", "1767225605"]);
    expect([f("git", "rc"), f("git", "log"), f("git", "label")]).toEqual(["0", "[main abc1234] Fix", 'git commit -m "Fix"']);
  });
});

describe("viewer sums up unlabelled git runs", () => {
  // Call a function of bin/viewer.py on stdin.
  const py = (fn: string, cmd: string) => {
    const code = `import sys, importlib.util as u
sys.argv = ["v", "/tmp"]
spec = u.spec_from_file_location("v", "${join(root, "bin/viewer.py")}")
m = u.module_from_spec(spec); spec.loader.exec_module(m)
print(m.${fn}(sys.stdin.read()), end="")`;
    return Bun.spawnSync(["python3", "-I", "-c", code], { stdin: Buffer.from(cmd) }).stdout.toString();
  };
  const summary = (cmd: string) => py("git_summary", cmd);

  test("a commit shows its whole message", () =>
    expect(py("commit_message", 'git add -A && git commit -q -m "Title\n\nBody with \\"quotes\\".\n\nCo-Authored-By: X" && git push'))
      .toBe('Title\n\nBody with "quotes".\n\nCo-Authored-By: X'));
  test("a heredoc commit message, whole", () =>
    expect(py("commit_message", "git commit -m \"$(cat <<'EOF'\nFix it\n\nWhy.\nEOF\n)\"")).toBe("Fix it\n\nWhy."));
  test("no message outside a commit", () => expect(py("commit_message", "git status")).toBe(""));
  test("commit hash from commit, push range, reset and a quiet commit's log line", () => {
    expect(py("git_hash", "[main (root-commit) a3d7fe2] first")).toBe("a3d7fe2");
    expect(py("git_hash", "[main 1111111] x\n   1111111..2222222  main -> main")).toBe("2222222");
    expect(py("git_hash", "HEAD is now at deadbee msg")).toBe("deadbee");
    expect(py("git_hash", "78c8eb3 Deck: no blank row")).toBe("78c8eb3");
    expect(py("git_hash", "Everything up-to-date")).toBe("");
  });
  test("git steps only, flags dropped, message cut", () =>
    expect(summary('cd repo && rm -rf x && git add -A && git diff --cached --stat && git commit -q -m "Ship it\n\nbody" && git push -q 2>&1 | tail -1'))
      .toBe('git add · git commit "Ship it" · git push'));
  test("-C path is not the subcommand", () => expect(summary("git -C ~/repo status --short")).toBe("git status"));
  test("a message line starting with git is not a step", () =>
    expect(summary('git add -A && git commit -q -m "Title\n\nright under\ngit commit." && git push -q')).toBe('git add · git commit "Title" · git push'));
  test("git after a heredoc is still found", () =>
    expect(summary("cd repo && python3 - <<'PY'\nprint('x')\nPY\nbash -n bin/x && git rm -q bin/a bin/b")).toBe("git rm"));
  test("reads dropped when there are writes", () =>
    expect(summary("git status -sb | head -1; git add -A && git diff --cached --stat && git commit -m 'x'")).toBe('git add · git commit "x"'));
  test("ls-remote and other reads are not steps next to a push", () =>
    expect(summary("git remote -v; git ls-remote --heads origin main && git stash list && git push")).toBe("git push"));
  test("repository state for the list border: branch, unpushed, uncommitted", () => {
    const { mkdtempSync, writeFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const repo = mkdtempSync(join(tmpdir(), "steading-repo-"));
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a]);
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "x");
    const state = () => py("repo_state", repo).replace(/\x1b\[[0-9;]*m/g, "");
    expect(state()).toBe(" main · clean ");
    writeFileSync(join(repo, "a"), "a");
    expect(state()).toBe(" main · 1 changed ");
    expect(py("repo_state", "/")).toBe("");
  });
  test("heredoc commit message", () =>
    expect(summary("git commit -m \"$(cat <<'EOF'\nFix the flicker\n\nbody\nEOF\n)\"")).toBe('git commit "Fix the flicker"'));
});

describe("classify reads a command line by its shell tokens", () => {
  const classify = (cmd: string) => JSON.parse(Bun.spawnSync(["python3", "-I", join(root, "bin/classify")], { stdin: Buffer.from(cmd) }).stdout.toString());
  const cases: [string, string, string][] = [
    ['cd /x; L=/tmp/s; env -u DATABASE_URL -u GIWA_RPC_URL pnpm test -- --force > $L/t.log 2>&1; echo "exit=$?"', "test", "pnpm test -- --force"],
    ["pnpm test:outage-watch:integration > /tmp/x 2>&1", "test", "pnpm test:outage-watch:integration"],
    ['cd /x/y; pnpm build 2>&1 | grep -vE "^\\s*$" | tail -25; echo "exit=$?"', "build", "pnpm build"],
    ["git status -sb | head -1; forge test --match-path 'test/*' 2>&1 | grep FAIL", "test", "forge test --match-path 'test/*'"],
    ["/usr/bin/time -p ./build.sh > /tmp/b.log 2>&1; git status --short", "build", "./build.sh"],
    ["sudo -E nice -n 5 cargo test", "test", "cargo test"],
    ["npx vercel --prod --yes 2>&1 | tail -3", "deploy", "npx vercel --prod --yes"],
    ["git add -A && git commit -m 'x' && git push", "git", ""],
    ["echo forge test", "", ""],
    ["git status --short", "", ""],
  ];
  for (const [cmd, kind, label] of cases) test(cmd, () => expect(classify(cmd)).toMatchObject({ kind, label }));
  test("a commit message mentioning a runner stays a commit", () =>
    expect(classify('git add -A && git commit -q -m "Fix it\n\nCatches e.g. env -u A pnpm test -- --force and\npnpm test:a:b." && git push -q'))
      .toMatchObject({ kind: "git", label: "" }));
  test("sudo in front is never run live", () => expect(classify("sudo cargo test").routable).toBe(false));
  test("time in front may run live", () => expect(classify("time forge test").routable).toBe(true));
});

describe("servers lists the project's dev servers", () => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");

  test("a server started from a workspace shell counts even outside the project", async () => {
    const project = mkdtempSync(join(tmpdir(), "steading-project-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "steading-sibling-"));
    // A "pane shell" that starts a server in a sibling directory, like an agent would.
    const shell = Bun.spawn(["sh", "-c", "cd \"$0\" && python3 -m http.server 0 --bind 127.0.0.1", elsewhere], { stdout: "ignore", stderr: "ignore" });
    try {
      let out = "";
      for (let i = 0; i < 40 && !out; i++) {
        await Bun.sleep(100);
        out = Bun.spawnSync([join(root, "bin/servers"), project, String(shell.pid)]).stdout.toString();
      }
      expect(out).toMatch(/^\d+\t\d+\t\S*python3? -m http.server/im);
      expect(Bun.spawnSync([join(root, "bin/servers"), project]).stdout.toString()).toBe(""); // not without the shell
    } finally {
      shell.kill();
      Bun.spawnSync(["pkill", "-f", `http.server 0 --bind 127.0.0.1`]);
    }
  });
});

describe("the agents section reads the session's subagents", () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
  const { tmpdir } = require("node:os");

  test("states come from the main transcript, activity from each subagent's own", () => {
    const dir = mkdtempSync(join(tmpdir(), "steading-session-"));
    const main = join(dir, "s1.jsonl");
    const subs = join(dir, "s1", "subagents");
    mkdirSync(join(subs, "workflows", "wf_1"), { recursive: true });
    const line = (o: object) => JSON.stringify(o);
    const agent = (folder: string, id: string, meta: object, rows: object[]) => {
      writeFileSync(join(folder, `agent-${id}.meta.json`), JSON.stringify(meta));
      writeFileSync(join(folder, `agent-${id}.jsonl`), rows.map(line).join("\n") + "\n");
    };
    const at = "2026-01-01T00:00:00Z";
    agent(subs, "aaa", { agentType: "Explore", description: "Map the repo", toolUseId: "t1" }, [
      { type: "user", timestamp: at, cwd: "/repo", message: { content: "List the files" } },
      { type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "x1", name: "Read", input: { file_path: "/repo/src/a.ts" } }] } },
      { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "x1" }] } },
      { type: "assistant", timestamp: at, message: { content: [{ type: "text", text: "Done mapping." }] } },
    ]);
    agent(subs, "bbb", { agentType: "general-purpose", description: "Fix it", toolUseId: "t2" }, [
      { type: "user", timestamp: at, message: { content: "Fix" } },
    ]);
    agent(join(subs, "workflows", "wf_1"), "ccc", { agentType: "Plan", description: "Plan it", toolUseId: "t3", requestShape: "background" }, [
      { type: "user", timestamp: at, message: { content: "Plan" } },
    ]);
    writeFileSync(main, [
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }, { type: "tool_result", tool_use_id: "t2", is_error: true }] } },
      { type: "queue-operation", content: "<task-notification>\n<task-id>ccc</task-id>\n<status>completed</status>\n</task-notification>" },
    ].map(line).join("\n") + "\n");
    const check = `
import os, sys, time
${PYLOAD}
v = load("v", sys.argv[1])
v.background = lambda fn, *a: fn(*a)  # inline, for the test
s = v.Agents(); s.session, s.looked = sys.argv[2], time.time()
s.read_main(); s.refresh()
print("listed", *(r.id for r in s.runs))  # ended subagents leave; the main agent stays, last (drawn on top)
for r in s.every:
    print(r.id, r.ended(), r.meta.get("agentType"), r.calls)
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), main], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(dir, "base") },
    });
    expect(r.stderr.toString()).toBe("");
    const out = r.stdout.toString().trim().split("\n").sort();
    expect(out).toEqual([
      "aaa done Explore 1",
      "bbb failed general-purpose 0",
      "ccc done Plan 0", // background, ended by its notification
      "listed main",
    ]);
  });

  test("a subagent's subagent sits under it on a branch line, ends by its parent's answer, and leaves its team card", () => {
    const dir = mkdtempSync(join(tmpdir(), "steading-session-"));
    const main = join(dir, "s1.jsonl");
    const subs = join(dir, "s1", "subagents");
    mkdirSync(subs, { recursive: true });
    const now = new Date().toISOString();
    const agent = (id: string, meta: object, rows: object[]) => {
      writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify(meta));
      writeFileSync(join(subs, `agent-${id}.jsonl`), rows.map((o) => JSON.stringify(o)).join("\n") + "\n");
    };
    const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    // p1 (oldest) runs k1, which runs g1; p2 started later; k2 was answered by p1, so it is done.
    agent("p1", { description: "Parent one", toolUseId: "t1", spawnDepth: 1 }, [
      { type: "user", timestamp: at(50), message: { content: "go" } },
      { type: "user", timestamp: at(5), message: { content: [{ type: "tool_result", tool_use_id: "tk2" }] } },
    ]);
    agent("p2", { description: "Parent two", toolUseId: "t2", spawnDepth: 1 }, [{ type: "user", timestamp: at(40), message: { content: "go" } }]);
    agent("k1", { description: "Kid", agentType: "foreman-builder", toolUseId: "tk1", spawnDepth: 2, parentAgentId: "p1" }, [
      { type: "user", timestamp: at(30), message: { content: "go" } },
      { type: "assistant", timestamp: at(29), message: { content: [{ type: "text", text: "Reading the **spec**" }] } },
    ]);
    agent("g1", { description: "Grandkid", name: "scout-a", agentType: "foreman-scout", toolUseId: "tg1", spawnDepth: 3, parentAgentId: "k1" }, [{ type: "user", timestamp: at(20), message: { content: "go" } }]);
    agent("k2", { description: "Done kid", toolUseId: "tk2", spawnDepth: 2, parentAgentId: "p1" }, [{ type: "user", timestamp: at(25), message: { content: "go" } }]);
    writeFileSync(main, JSON.stringify({ type: "user", timestamp: now, message: { content: "hi" } }) + "\n");
    const check = `
import sys, time
${PYLOAD}
v = load("v", sys.argv[1])
v.background = lambda fn, *a: fn(*a)
s = v.Agents(); s.session, s.looked = sys.argv[2], time.time()
s.read_main(); s.refresh()
print(*(r.id for r in reversed(s.runs)))  # top down, as drawn
print(" | ".join(r.label() for r in reversed(s.runs) if r.id in ("k1", "g1")))  # name and what it is doing, on branch lines
print(" | ".join(r.subline()[0].strip() for r in reversed(s.runs) if r.id in ("k1", "g1")))  # the work it was given
p1 = next(r for r in s.runs if r.id == "p1")
print(*(k.id for k in p1.team), "|", v.ANSI.sub("", v.team_card(p1.team, 60)[0]).strip("─╭╮ "))  # its subagents still there
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), main], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(dir, "base") },
    });
    expect(r.stderr.toString()).toBe("");
    const [order, branches, given, team] = r.stdout.toString().trim().split("\n");
    expect(order).toBe("main p2 p1 k1 g1");
    // The name it was called with, else its type; the doing column lines up across the list.
    expect(branches).toBe("  └ foreman-builder  Reading the spec |     └ scout-a");
    expect(given).toBe("Kid | Grandkid");
    expect(team).toBe("k1 | subagents 1/1 at work"); // k2 reported back, so it has gone
  });

  test("an agent whose turn ended waits on its background command, its subagents at work or its idle teammates, dimmed, and leaves once they end", () => {
    const dir = mkdtempSync(join(tmpdir(), "steading-waiting-"));
    const check = `
import os, sys, json, time
${PYLOAD}
args = sys.argv[1:]; sys.argv = sys.argv[:1]
d = args[1]
v = load("v", args[0])
crew = load("crew", os.path.join(os.path.dirname(args[0]), "crew"))
import subagents
v.background = lambda fn, *a: fn(*a)
sub = f"{d}/s1/subagents"; os.makedirs(sub)
now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
row = lambda **o: json.dumps({"timestamp": now, **o}) + "\\n"
def agent(id, meta, *rows):
    json.dump({"agentType": "pm", "description": id, **meta}, open(f"{sub}/agent-{id}.meta.json", "w"))
    open(f"{sub}/agent-{id}.jsonl", "w").write("".join(rows) or row(type="user", message={"content": "go"}))
launch = row(type="user", message={"content": [{"type": "tool_result", "tool_use_id": "u1", "content": "Command running in background with ID: bg1."}]},
             toolUseResult={"backgroundTaskId": "bg1"})
root = os.path.dirname(v.BASE)
rec = lambda event, a: subagents.record(root, {"hook_event_name": event, "session_id": "s1", "agent_id": a})
agent("pm1", {}, launch)                                          # its background command runs on
agent("pm2", {}); agent("w2", {"parentAgentId": "pm2"})           # its subagent works
agent("pm3", {})                                                  # its teammates wait for a message
for t in ("t3a", "t3b"):
    agent(t, {"parentAgentId": "pm3", "taskKind": subagents.TEAMMATE}); rec("SubagentStart", t); rec("TeammateIdle", t)
agent("pm4", {})                                                  # nothing left: done
open(f"{d}/bg5.output", "w").write("ok\\n\\n[exited with code 0]\\n")    # its command has exited, no notification yet
agent("pm5", {}, row(type="user", message={"content": [{"type": "tool_result", "tool_use_id": "u5",
      "content": f"Command running in background with ID: bg5. Output is being written to: {d}/bg5.output. You will be notified."}]},
      toolUseResult={"backgroundTaskId": "bg5"}))
agent("pm6", {"finished": True}, launch.replace("bg1", "bg6"))    # its run is over: whatever it left runs on unwatched
launched_to = lambda t, out: row(type="user", message={"content": [{"type": "tool_result", "tool_use_id": t,
      "content": f"Command running in background with ID: {t}. Output is being written to: {out}. You will be notified."}]},
      toolUseResult={"backgroundTaskId": t})
agent("pm7", {}, launched_to("bg7", f"{d}/gone/tasks/bg7.output"))     # its tasks folder was cleaned up: ended
open(f"{d}/bg8.output", "w").write("running\\n"); os.chmod(f"{d}/bg8.output", 0)
agent("pm8", {}, launched_to("bg8", f"{d}/bg8.output"))           # unreadable: no word either way, still waited on
for a in ("pm1", "pm2", "pm3", "pm4", "pm5", "pm6", "pm7", "pm8"):
    rec("SubagentStart", a); rec("SubagentStop", a)
rec("SubagentStart", "w2")
open(f"{d}/s1.jsonl", "w").write(row(type="user", message={"content": "go"}))
s = v.Agents(); s.session, s.looked = f"{d}/s1.jsonl", time.time()
s.read_main(); s.refresh()
show = lambda: [f"{r.status()[0].replace(v.SPIN_MARK, '*')} {r.id}: {r.waiting or ''}" for r in reversed(s.runs[:-1])]
print(json.dumps(show()))
pm1 = next(r for r in s.every if r.id == "pm1")
print(json.dumps([pm1.state()[0], crew.live(root, sub), [k.id for k in s.main.team]]))
open(f"{sub}/agent-pm1.jsonl", "a").write(row(type="user", message={"content": "<task-notification>\\n<task-id>bg1</task-id>\\n<status>completed</status>\\n</task-notification>"}))
s.refresh()
print(json.dumps([show(), pm1.status()[0]]))
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), dir], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(dir, "st", "w1_p1"), STEADING_CACHE: join(dir, "cache") },
    });
    expect(r.stderr.toString()).toBe("");
    const [listed, more, after] = r.stdout.toString().trim().split("\n").map((l) => JSON.parse(l));
    expect(listed.sort()).toEqual(["* w2: ", "◷ pm1: waits on 1 background command", "◷ pm2: waits on 1 subagent",
      "◷ pm3: waits on 2 teammates", "◷ pm8: waits on 1 background command"].sort());
    // Waiting is no work for the $crew: only w2 is counted. The main agent's team card shows the waiting ones.
    expect(more).toEqual(["waiting", 1, expect.arrayContaining(["pm1", "pm2", "pm3"])]);
    expect(more[2]).not.toContain("pm4");
    expect(more[2]).not.toContain("pm5");
    expect(more[2]).not.toContain("pm6");
    expect([after[0].sort(), after[1]]).toEqual([["* w2: ", "◷ pm2: waits on 1 subagent", "◷ pm3: waits on 2 teammates",
      "◷ pm8: waits on 1 background command"].sort(), "✓"]);
  });

  test("a manager waiting quietly on its workers stays listed, its workers under it", () => {
    const { utimesSync } = require("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "steading-session-"));
    const main = join(dir, "s1.jsonl");
    const subs = join(dir, "s1", "subagents");
    mkdirSync(subs, { recursive: true });
    const go = [{ type: "user", timestamp: new Date().toISOString(), message: { content: "go" } }];
    const agent = (id: string, meta: object) => {
      writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify({ requestShape: "background", ...meta }));
      writeFileSync(join(subs, `agent-${id}.jsonl`), go.map((o) => JSON.stringify(o)).join("\n") + "\n");
    };
    agent("m1", { name: "dash-quality", agentType: "foreman", description: "Dashboard quality", spawnDepth: 1 });
    agent("w1", { agentType: "foreman-designer", description: "Template UI", spawnDepth: 2, parentAgentId: "m1" });
    const quiet = Date.now() / 1000 - 600; // the manager has written nothing for ten minutes
    utimesSync(join(subs, "agent-m1.jsonl"), quiet, quiet);
    writeFileSync(main, JSON.stringify(go[0]) + "\n");
    const check = `
import sys, time
${PYLOAD}
args = sys.argv[1:]; sys.argv = sys.argv[:1]
v = load("v", args[0])
v.background = lambda fn, *a: fn(*a)
s = v.Agents(); s.session, s.looked = args[1], time.time()
s.read_main(); s.refresh()
print(" | ".join(r.label() for r in reversed(s.runs)))
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), main], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(dir, "base") },
    });
    expect(r.stderr.toString()).toBe("");
    // Names in one column, then what each is doing (main: its request), lined up after the longest name;
    // the quiet manager waits on its worker.
    expect(r.stdout.toString().trim()).toBe(`${"main".padEnd(20)}  go |   dash-quality        waits on 1 subagent |   └ foreman-designer`);
  });

  test("the activity card shows a call that ran long with a button to its output in the jobs tab", () => {
    const dir = mkdtempSync(join(tmpdir(), "steading-session-"));
    const main = join(dir, "s1.jsonl");
    const job = join(dir, "base", "jobs", "runs", "1");
    mkdirSync(job, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    for (const [f, v] of [["id", "tj"], ["start", String(now - 20)], ["label", "Wait for the API to answer"], ["cmd", "sleep 60"], ["timeout", "120000"]])
      writeFileSync(join(job, f), v + "\n");
    writeFileSync(join(job, "source"), main + "\n"); // any file that exists: the call's output
    writeFileSync(main, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(),
      message: { content: [{ type: "tool_use", id: "tj", name: "Bash", input: { command: "sleep 60" } }] } }) + "\n");
    const check = `
import sys, time
${PYLOAD}
args = sys.argv[1:]; sys.argv = sys.argv[:1]  # the viewer takes its base from argv, else STEADING_BASE
v = load("v", args[0])
v.background = lambda fn, *a: fn(*a)
s = v.Agents(); s.session, s.looked = args[1], time.time()
s.read_main(); s.refresh()
went = []
s.jump = lambda kind, path: went.append((kind, path))
m = s.runs[-1]
lines = m.plain()
row = next(l for l in lines if "↗ jobs #1" in l)       # the call, in the activity card, with its button
print(row.strip("│ ").split("  ")[0])
print(m.activate(row), went[0][0], went[0][1] == args[2])
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), main, job], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(dir, "base") },
    });
    expect(r.stderr.toString()).toBe("");
    const [row, went] = r.stdout.toString().trim().split("\n");
    expect(row).toEndWith("Waiting 60s"); // the call as a phrase, its spinner before it
    expect(went).toBe("True jobs True");
  });

  test("unfolded, the activity card (long phrases wrapped) scrolls inside with its own cursor; esc folds it back onto its button", () => {
    const dir = mkdtempSync(join(tmpdir(), "steading-session-"));
    const main = join(dir, "s1.jsonl");
    mkdirSync(join(dir, "base"), { recursive: true });
    const rows = [];
    for (let i = 0; i < 30; i++) {
      const at = new Date(Date.now() - (30 - i) * 1000).toISOString();
      rows.push({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}`, description: `Step ${i}` + (i % 3 ? "" : " with a long description that goes well past the width of one row of the card") } }] } });
      rows.push({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }] } });
    }
    writeFileSync(main, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const check = `
import sys, time
${PYLOAD}
args = sys.argv[1:]; sys.argv = sys.argv[:1]
v = load("v", args[0])
v.background = lambda fn, *a: fn(*a)
s = v.Agents(); s.session, s.looked = args[1], time.time()
s.read_main(); s.refresh()
shown = lambda: [v.ANSI.sub("", l) for l in s.frame(60, 30)[0]]
m = s.runs[-1]
s.list_key("\\r"); shown()                       # into the detail, on the fold (its only button)
s.key("\\r"); p = shown()                        # unfolded: a window, newest first, all of it in view
print(s.inside(), sum("Step" in l for l in p) > 5, any("1–" in l and "of 30" in l for l in p),
      any(l.strip("│ ").startswith("past the width") for l in p), not any("…" in l for l in p))  # wrapped, not cut
for k in "jjj": s.key(k)
s.key("\\x04"); shown()                          # j a row, ctrl+d half the window
print(m.activity_at > 3, m.activity_top > 0)
s.key("G"); p = shown()
print(any("Step 0" in l for l in p), any("of 30" in l and l.split("of 30")[0].rstrip().endswith("30") for l in p))
s.key("\\x1b"); p = shown()                      # esc folds; the button is picked again
print(s.inside(), s.focus, m.focus_key, any("▾ 25 more" in l for l in p))
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), main], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(dir, "base") },
    });
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim().split("\n")).toEqual(["True True True True True", "True True", "True True", "False log activity-fold True"]);
  });
});

describe("a reported run's log: error lines and the test summary", () => {
  const check = `
import sys
${PYLOAD}
sys.argv = ["v", "/tmp"]
v = load("v", "${join(root, "bin/viewer.py")}")
for line in ["AssertionError: expected 401", "44 passed, 0 failed", "0 errors, 2 warnings", "error[E0308]: mismatched", "✓ all good"]:
    print(v.line_mark(line) or "-")
for log in [[" 131 pass", " 0 fail"], ["=== 1 failed, 44 passed in 0.1s ==="], ["test result: FAILED. 44 passed; 1 failed; 2 ignored"],
            ["      Tests  1 failed | 44 passed (45)"], ["Ran 3 test suites: 30 tests passed, 1 failed, 0 skipped (31 total tests)"], ["no summary"]]:
    print(v.test_counts(log))
`;
  test("marks and counts", () => {
    const r = Bun.spawnSync(["python3", "-I", "-c", check]);
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim().split("\n")).toEqual([
      "error", "-", "warn", "error", "-",
      "(131, 0, 0)", "(44, 1, 0)", "(44, 1, 0)", "(44, 1, 0)", "(30, 1, 0)", "None",
    ]);
  });
});

describe("an agent's calls read as phrases", () => {
  test("a command's description, else its main step in words; a verb and what it works on", () => {
    const check = `
import sys
${PYLOAD}
sys.argv = ["v", "/tmp"]
v = load("v", "${join(root, "bin/viewer.py")}")
for name, args in [("Bash", {"command": "cd x; python3 - <<'EOF'", "description": "Fix the dedupe"}),
                   ("Bash", {"command": "pnpm test\\necho done"}),
                   ("Bash", {"command": "cd /repo/x && ls -la docs"}),
                   ("Bash", {"command": "cd /tmp; claude --version"}),
                   ("Bash", {"command": "cd x && cat > s3.py <<'EOF'\\nprint(1)\\nEOF\\n./venv/bin/python s3.py 2>&1 | tail -5"}),
                   ("Bash", {"command": "sleep 60; cat /private/tmp/claude-501/some-project/tasks/b1.output"}),
                   ("Bash", {"command": "x", "description": 'git: git commit -m "Fix X" && git push'}),
                   ("Read", {"file_path": "/repo/lib/llm.ts"}),
                   ("Grep", {"pattern": "NAMES", "path": "/repo/lib"}),
                   ("WebFetch", {"url": "https://docs.anthropic.com/en/batch"}),
                   ("Agent", {"description": "Map the tests"})]:
    print(v.tool_summary(name, args, "/repo"))
for kind, command in [("test", "bun test test/hook.test.ts"), ("test", "forge test --match-path 'test/*'"),
                      ("build", "cargo build --release"), ("build", "docker build -t web ."), ("deploy", "vercel --prod")]:
    print(v.command_phrase(command, "", kind))
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check]);
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim().split("\n")).toEqual([
      "Fix the dedupe", "Running all the tests", "Listing docs", "Running claude", "Running s3.py", "Reading b1.output", "Committing: Fix X", "Reading lib/llm.ts", "Searching for NAMES in lib",
      "Reading docs.anthropic.com", "Handing off: Map the tests",
      "Testing hook.test.ts", "Testing test/*", "Building for release", "Building the image web", "Deploying to production",
    ]);
  });
});

describe("jobs: other commands followed while they run", () => {
  const { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const env = (tmp: string) => ({ PATH: process.env.PATH!, TMPDIR: tmp, HERDR_ENV: "1", HERDR_PANE_ID: "w9:p9", HERDR_SOCKET_PATH: "/nonexistent", CLAUDE_PLUGIN_ROOT: root });
  const call = { tool_name: "Bash", tool_use_id: "toolu_J", session_id: "S1", cwd: "/tmp" };
  const start = (tmp: string, command: string, extra: object = {}) =>
    Bun.spawnSync([hook], { stdin: Buffer.from(JSON.stringify({ ...call, tool_input: { command, description: "Wait for it", timeout: 60000, ...extra } })), env: env(tmp) });
  const finish = (tmp: string, command: string) =>
    Bun.spawnSync([join(root, "bin/record")], {
      stdin: Buffer.from(JSON.stringify({ ...call, hook_event_name: "PostToolUse", tool_input: { command }, tool_response: { stdout: "up", stderr: "" } })), env: env(tmp),
    });
  const job = (tmp: string) => join(tmp, "steading/w9_p9/jobs/runs/1");

  test("a command that is not routed is filed as a job, unchanged", () => {
    const tmp = mkdtempSync(join(tmpdir(), "steading-"));
    const r = start(tmp, "sleep 30; curl -s localhost:3000");
    expect(r.stdout.toString()).toBe("");
    expect(readFileSync(join(job(tmp), "label"), "utf8").trim()).toBe("Wait for it");
    expect(readFileSync(join(job(tmp), "timeout"), "utf8").trim()).toBe("60000");
    rmSync(tmp, { recursive: true }); // bin/job stops once its run is gone
  });
  test("background calls and what other tabs show are not jobs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "steading-"));
    start(tmp, "sleep 30", { run_in_background: true });
    start(tmp, "npm test");
    start(tmp, "bun test 2>&1 | grep -E fail"); // not routed, but the test tab files it
    start(tmp, "git push", { description: "git: git push" });
    expect(existsSync(job(tmp))).toBe(false);
  });
  test("record keeps a job of 10s or more with its output and drops a short one", () => {
    const tmp = mkdtempSync(join(tmpdir(), "steading-"));
    start(tmp, "sleep 30");
    writeFileSync(join(job(tmp), "start"), `${Math.floor(Date.now() / 1000) - 20}\n`);
    finish(tmp, "sleep 30");
    expect(readFileSync(join(job(tmp), "rc"), "utf8").trim()).toBe("0");
    expect(readFileSync(join(job(tmp), "log"), "utf8").trim()).toBe("up");
    const short = mkdtempSync(join(tmpdir(), "steading-"));
    start(short, "sleep 1");
    writeFileSync(join(job(short), "start"), `${Math.floor(Date.now() / 1000) - 1}\n`);
    finish(short, "sleep 1");
    expect(existsSync(job(short))).toBe(false);
  });
});

describe("one deck per agent", () => {
  test("an opener inside the repository's .git (a wanjang run folder) records the repository as the root", () => {
    const { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-paneroot-"));
    writeFileSync(join(dir, "herdr"), `#!/bin/sh
case "$1 $2" in
  "plugin pane") echo '{"result":{"plugin_pane":{"pane":{"pane_id":"p1"}}}}';;
  "pane get") exit 1;;
  *) echo '{}';;
esac
`);
    chmodSync(join(dir, "herdr"), 0o755);
    Bun.spawnSync(["git", "init", "-q", join(dir, "repo")]);
    const run = join(dir, "repo", ".git", "wanjang", "2026-11-04-run");
    mkdirSync(run, { recursive: true });
    const env = { PATH: `${dir}:${process.env.PATH}`, TMPDIR: join(dir, "tmp"), HERDR_PANE_ID: "w1:p0", HERDR_SOCKET_PATH: "/nonexistent", GIT_CEILING_DIRECTORIES: dir };
    Bun.spawnSync(["bash", "bin/pane", "", run], { env, cwd: root });
    const { realpathSync } = require("node:fs");
    expect(realpathSync(readFileSync(join(dir, "tmp", "steading", "w1_p0", "root"), "utf8").trim())).toBe(realpathSync(join(dir, "repo")));
  }, 30000);

  test("openers and L flips at the same moment leave a single deck", () => {
    const { mkdtempSync, writeFileSync, chmodSync, readdirSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-race-"));
    // A herdr that is slow to open a pane, so the openers overlap.
    writeFileSync(join(dir, "herdr"), `#!/bin/bash
d=${dir}
case "$1 $2" in
  "plugin pane") sleep 0.3; n=$(( $(ls $d/panes 2>/dev/null | wc -l) + 1 )); mkdir -p $d/panes; touch $d/panes/p$n
                 echo "{\\"result\\":{\\"plugin_pane\\":{\\"pane\\":{\\"pane_id\\":\\"p$n\\"}}}}";;
  "pane get") [ -e $d/panes/$3 ] && echo '{"result":{"pane":{"focused":false}}}' || exit 1;;
  "pane close") rm -f $d/panes/$3;;
  *) echo '{}';;
esac
`);
    chmodSync(join(dir, "herdr"), 0o755);
    const env = { PATH: `${dir}:${process.env.PATH}`, TMPDIR: join(dir, "tmp"), HERDR_PANE_ID: "w1:p0", HERDR_SOCKET_PATH: "/nonexistent" };
    const base = join(dir, "tmp", "steading", "w1_p0");
    const burst = (cmd: string) =>
      Bun.spawnSync(["bash", "-c", `for i in 1 2 3 4 5; do ${cmd} & done; wait`], { env, cwd: root });
    burst(`bash bin/pane "" /tmp >/dev/null`);
    expect(readdirSync(join(dir, "panes")).length).toBe(1);
    burst(`bash bin/deck flip ${base}`);
    expect(readdirSync(join(dir, "panes")).length).toBe(1);
  }, 30000);
});

describe("the crew spinner", () => {
  test("counts the main agent while its turn runs plus the subagents writing lately", () => {
    const check = `
import importlib.util, importlib.machinery, os, sys, tempfile, time
spec = importlib.util.spec_from_loader("crew", importlib.machinery.SourceFileLoader("crew", sys.argv[1]))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
state, folder = tempfile.mkdtemp(), tempfile.mkdtemp()
out = [m.at_work(state, folder)]                                     # nobody
open(os.path.join(state, "main-busy"), "w").close(); out.append(m.at_work(state, folder))   # the main turn
for n in "ab": open(os.path.join(folder, f"agent-{n}.jsonl"), "w").close()
out.append(m.at_work(state, folder))                                 # main + 2 subagents
os.remove(os.path.join(state, "main-busy")); out.append(m.at_work(state, folder))           # turn over
for f in os.listdir(folder): os.utime(os.path.join(folder, f), (time.time() - 200,) * 2)
out.append(m.at_work(state, folder))                                 # all quiet
open(os.path.join(state, "main-busy"), "w").close(); os.utime(os.path.join(state, "main-busy"), (time.time() - 700,) * 2)
out.append(m.at_work(state, folder))                                 # a mark left by a turn that never stopped
print(*out)
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/crew")]);
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim()).toBe("0 1 3 2 0 0");
  });
});

describe("one record of the subagents at work, for the $crew and the deck", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, utimesSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  // A session with a teammate ("tm"), its transcript silent for 15 minutes (Claude Code writes a
  // turn only when it ends), and two ordinary background task agents ("job", "c") silent for 40
  // (past the fallback's horizon, for agents the hooks never named).
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "steading-record-"));
    writeFileSync(join(dir, "herdr"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "herdr"), 0o755);
    const main = join(dir, "S.jsonl");
    const subs = join(dir, "S", "subagents");
    mkdirSync(subs, { recursive: true });
    writeFileSync(main, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { content: "go" } }) + "\n");
    for (const [id, meta] of [
      ["tm", { name: "sw-users", agentType: "sw-users", description: "Sweep", spawnDepth: 0, requestShape: "background", taskKind: "in_process_teammate" }],
      ["job", { agentType: "Explore", description: "Map it", toolUseId: "t1", spawnDepth: 1, requestShape: "background" }],
      ["c", { agentType: "Explore", description: "Third", toolUseId: "t3", spawnDepth: 1, requestShape: "background" }],
    ] as [string, object][]) {
      const quiet = Date.now() / 1000 - (id === "tm" ? 900 : 2400);
      writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify(meta));
      writeFileSync(join(subs, `agent-${id}.jsonl`), JSON.stringify({ type: "user", timestamp: new Date(quiet * 1000).toISOString(), message: { content: "go" } }) + "\n");
      utimesSync(join(subs, `agent-${id}.jsonl`), quiet, quiet);
    }
    return { dir, main };
  };
  // Python beside the deck and the crew: both loaded, hook() runs bin/sidebar as Claude Code would.
  const prelude = `
import json, os, random, subprocess, sys, time
${PYLOAD}
args = sys.argv[1:]; sys.argv = sys.argv[:1]
root, main = args[0], args[1]
v = load("v", os.path.join(root, "bin/viewer.py"))
crew = load("crew", os.path.join(root, "bin/crew"))
import subagents
v.background = lambda fn, *a: fn(*a)
state = os.environ["STEADING_BASE"]
s = v.Agents(); s.session, s.looked = main, time.time()
def hook(name, agent=None, **more):
    event = {"hook_event_name": name, "session_id": "S", "transcript_path": main, "cwd": os.path.dirname(main), **more}
    if agent:
        event["agent_id"] = agent
    subprocess.run([os.path.join(root, "bin/sidebar")], input=json.dumps(event).encode())
def deck():
    s.read_main(); s.refresh()
    return sum(r.status()[1] == v.AMBER_RGB for r in s.every)
def look():
    """crew's count, the deck's, the subagents listed, and the main agent's team card"""
    n = deck()
    card = v.ANSI.sub("", (v.team_card(s.main.team, 60) or [""])[0]).strip("─╭╮ ")
    return f"{crew.live(os.path.dirname(state), main[:-len('.jsonl')] + '/subagents')} {n} [{' '.join(r.id for r in s.runs[:-1])}] {card}"
`;
  const run = (body: string) => {
    const { dir, main } = fixture();
    const env = { PATH: process.env.PATH!, HOME: join(dir, "home"), TMPDIR: dir, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1",
      HERDR_BIN_PATH: join(dir, "herdr"), STEADING_BASE: join(dir, "steading", "w1_p1"), STEADING_CACHE: join(dir, "cache") };
    const r = Bun.spawnSync(["python3", "-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(join(root, "bin"))})\n` + prelude + body, root, main], { env });
    expect(r.stderr.toString()).toBe("");
    return r.stdout.toString().trim().split("\n");
  };

  test("a silent teammate works from its start to its stop; compaction keeps it, a new process clears it", () => {
    expect(run(`
print(look())
hook("SubagentStart", "tm"); print(look())                          # silent 15 min, yet at work
hook("SessionStart", source="compact"); print(look())              # the process goes on: still at work
hook("SubagentStop", "tm"); print(look())                           # idle: not listed, still in the team
hook("SubagentStart", "tm"); print(look())                          # a new message
hook("TeammateIdle", "tm", teammate_name="sw-users"); print(look())
hook("SubagentStart", "tm"); hook("SessionStart", source="startup"); print(look())   # a new process
hook("SubagentStart", "job"); print(look())
hook("SubagentStop", "job"); print(look())                          # done: gone from the team too
hook("SubagentStart", "job"); hook("SessionStart", source="resume"); print(look())
`)).toEqual([
      "0 0 [] subagents 0/1 at work",   // no record yet: by its transcript, quiet but still there
      "1 1 [tm] subagents 1/1 at work",
      "1 1 [tm] subagents 1/1 at work",
      "0 0 [] subagents 0/1 at work",
      "1 1 [tm] subagents 1/1 at work",
      "0 0 [] subagents 0/1 at work",
      "0 0 [] ",
      "1 1 [job] subagents 1/1 at work",
      "0 0 [] ",
      "0 0 []",
    ]);
  }, 30000);

  test("a working agent whose meta says finished, written after its start, is done; a resumed one (meta older) still works", () => {
    expect(run(`
root_, subs = os.path.dirname(state), main[:-len(".jsonl")] + "/subagents"
t = time.time_ns()
for a, start in (("job", t - 10**9), ("c", t + 10**9)):            # "c" started again after the meta's last write
    subagents.record(root_, {"hook_event_name": "SubagentStart", "session_id": "S", "agent_id": a}, now=start)
    with open(f"{subs}/agent-{a}.meta.json", "w") as f:
        json.dump({"finished": True}, f)
got = subagents.states(root_, "S", folder=subs)
print(got["job"][0], got["c"][0], subagents.states(root_, "S")["job"][0])   # without the folder, as before
`)).toEqual(["done working working"]);
  }, 30000);

  test("a stop processed before its start still ends it; a kill's notification ends one with no stop; stale starts drop", () => {
    expect(run(`
root_ = os.path.dirname(state)
subagents.record(root_, {"hook_event_name": "SubagentStart", "session_id": "S", "agent_id": "tm"}, now=time.time_ns() - 4 * 3600 * 10**9)
print(look())                                                      # a start 4 h old with no stop: died
t = time.time_ns()
subagents.record(root_, {"hook_event_name": "SubagentStop", "session_id": "S", "agent_id": "job"}, now=t + 2)
subagents.record(root_, {"hook_event_name": "SubagentStart", "session_id": "S", "agent_id": "job"}, now=t + 1)   # late
subagents.record(root_, {"hook_event_name": "SubagentStart", "session_id": "S", "agent_id": "tm"}, now=t + 4)
subagents.record(root_, {"hook_event_name": "SessionStart", "session_id": "S", "source": "startup"}, now=t + 5)
subagents.record(root_, {"hook_event_name": "SubagentStart", "session_id": "S", "agent_id": "tm"}, now=t + 3)    # late, before the clear
print(look())
hook("SubagentStart", "c")
with open(main, "a") as f:  # killed: its notification, no SubagentStop
    f.write(json.dumps({"type": "queue-operation", "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.999Z", time.gmtime(time.time() + 1)),
                        "content": "<task-notification><task-id>c</task-id><status>killed</status></task-notification>"}) + "\\n")
print(deck(), [r.id for r in s.runs[:-1]], next(r for r in s.every if r.id == "c").status()[0])  # (the $crew can't see it)
`)).toEqual(["0 0 [] ", "0 0 [] ", "0 [] ⊘"]);
  }, 30000);

  test("over random hook orders the deck's count is the $crew's, and the hooks' latest word", () => {
    expect(run(`
rng, root_, bad = random.Random(7), os.path.dirname(state), 0
for trial in range(40):
    sid = "S"
    os.remove(subagents.log_path(root_, sid)) if os.path.exists(subagents.log_path(root_, sid)) else None
    subagents._read.clear()
    t0, latest, cleared = time.time_ns() - 10**12, {}, 0
    events = []
    for n in range(rng.randrange(1, 14)):
        kind = rng.choice(["SubagentStart", "SubagentStart", "SubagentStop", "TeammateIdle", "compact", "startup"])
        agent = rng.choice(["tm", "job", "c"])
        events.append((t0 + n * 1000, kind, agent))
    order = events[:]
    rng.shuffle(order)  # processed in any order
    for t, kind, agent in order:
        e = {"hook_event_name": "SessionStart", "source": kind} if kind in ("compact", "startup") else {"hook_event_name": kind, "agent_id": agent}
        e.update(session_id=sid, transcript_path=main)
        subagents.record(root_, e, now=t)
        crew_n = crew.live(root_, main[:-len(".jsonl")] + "/subagents")
        bad += crew_n != deck()
    last = {}
    for t, kind, agent in events:
        if kind == "startup":
            last = {}
        elif kind != "compact":
            last[agent] = kind
    bad += crew_n != sum(k == "SubagentStart" for k in last.values())
print(bad)
`)).toEqual(["0"]);
  }, 30000);
});

describe("context percent from the statusline", () => {
  const run = (setup: (dir: string) => void) => {
    const { mkdtempSync, mkdirSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-ctx-"));
    mkdirSync(join(dir, "steading", "statusline"), { recursive: true });
    setup(join(dir, "steading", "statusline"));
    const code = `import sys, importlib.util as u
sys.argv = ["v", "/tmp"]
spec = u.spec_from_file_location("v", "${join(root, "bin/viewer.py")}")
m = u.module_from_spec(spec); spec.loader.exec_module(m)
d = m.Digest(); d.context = 184000; d.sid = "s1"
print(m.context_use(d), end="")`;
    return Bun.spawnSync(["python3", "-I", "-c", code], { env: { PATH: process.env.PATH!, TMPDIR: dir } }).stdout.toString();
  };
  const body = (sid: string) => JSON.stringify({ session_id: sid, context_window: { context_window_size: 1000000, used_percentage: 19 } });
  const { writeFileSync, utimesSync } = require("node:fs");

  test("a fresh file of this session gives the window and percent", () =>
    expect(run((d) => writeFileSync(join(d, "s1.json"), body("s1")))).toBe("(19, 1000000)"));
  test("a stale file, another session's, or none falls back to the guess", () => {
    expect(run((d) => { writeFileSync(join(d, "s1.json"), body("s1")); const old = Date.now() / 1000 - 3600; utimesSync(join(d, "s1.json"), old, old); })).toBe("(92, 200000)");
    expect(run((d) => writeFileSync(join(d, "s1.json"), body("other")))).toBe("(92, 200000)");
    expect(run(() => {})).toBe("(92, 200000)");
  });
});

describe("herdr sidebar tokens", () => {
  test("the hook reports the agent's repository, context use and tasks, once per 3s; a subagent starts the $crew spinner", () => {
    const { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-sidebar-"));
    writeFileSync(join(dir, "herdr"), `#!/bin/sh\necho "$@" >> ${dir}/calls\n`);
    chmodSync(join(dir, "herdr"), 0o755);
    const transcript = join(dir, "s1.jsonl");
    const usage = (input: number) => JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(),
      message: { id: `m${input}`, model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: input, cache_read_input_tokens: 0, output_tokens: 10 } } });
    writeFileSync(transcript, [usage(1000), usage(170000)].join("\n") + "\n");
    Bun.spawnSync(["git", "init", "-q", join(dir, "repo")]);
    writeFileSync(join(dir, "repo", "a.txt"), "x");
    // Claude Code's task list for the session: one file per task.
    const tasks = join(dir, "home", ".claude", "tasks", "session-abcd1234");
    require("node:fs").mkdirSync(tasks, { recursive: true });
    ["completed", "in_progress", "pending"].forEach((status, i) =>
      writeFileSync(join(tasks, `${i + 1}.json`), JSON.stringify({ id: String(i + 1), subject: "t", status })));
    const env = { PATH: process.env.PATH!, HOME: join(dir, "home"), TMPDIR: dir, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: join(dir, "herdr") };
    const hook = (event: object) =>
      Bun.spawnSync(["python3", "-I", join(root, "bin/sidebar.py")], { env, stdin: Buffer.from(JSON.stringify(event)) });
    const event = { hook_event_name: "PostToolUse", session_id: "abcd1234-0000", cwd: join(dir, "repo"), transcript_path: transcript };
    hook(event);
    hook(event); // within 3s: skipped
    hook({ ...event, agent_id: "sub" }); // a subagent: only the crew token
    const all = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
    const calls = all.filter((c) => c.includes("--source steading "));
    expect(calls.length).toBe(1);
    // A subagent at work: no repository report; it hands the spinning $crew to bin/crew (over herdr's socket).
    expect(all.some((c) => c.includes("--token repo=") && c !== calls[0])).toBe(false);
    // 170k of 200k: 85%, past 80%, so it goes out as $ctxhot.
    expect(calls[0]).toContain("--token repo=");
    expect(calls[0]).toContain("--token repostate=1 changed");
    expect(calls[0]).toContain("--token model=󰚩 opus-5-5");
    expect(calls[0]).toContain("--clear-token ctx --token ctxhot=󰍛 ▰▰▰▰▱ 85%");
    expect(calls[0]).toContain("--token tasks= ▰▰▱▱▱ 1/3");
    expect(calls[0]).toContain("--token tree1=├ --token tree2=├ --token tree3=└");
    const pane = () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter((c) => c.includes("--source steading ")).length;
    hook({ ...event, hook_event_name: "Stop" }); // the end of a turn is not throttled, but unchanged values are not re-sent
    expect(pane()).toBe(1);
    writeFileSync(join(tasks, "3.json"), JSON.stringify({ id: "3", subject: "t", status: "completed" }));
    hook({ ...event, hook_event_name: "Stop" }); // a changed value goes out
    expect(pane()).toBe(2);
    hook({ ...event, hook_event_name: "Stop" });
    expect(pane()).toBe(2);
    require("node:fs").rmSync(join(dir, "steading", "w1_p1", "sidebar")); // (SessionStart is throttled like a tool call)
    hook({ ...event, hook_event_name: "SessionStart" }); // a new session: the cache is cleared
    expect(pane()).toBe(3);
    expect(existsSync(join(dir, "steading", "w1_p1", "sidebar"))).toBe(true);
  });

  test("outside a git repository $repo and $wsrepo say \"no git\" with a folder icon, and the guide stays", () => {
    const { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-nogit-"));
    writeFileSync(join(dir, "herdr"), `#!/bin/sh
echo "$@" >> ${dir}/calls
[ "$1 $2" = "pane get" ] && echo '{"result":{"pane":{"workspace_id":"w1","tab_id":"w1:t1"}}}'
exit 0
`);
    chmodSync(join(dir, "herdr"), 0o755);
    mkdirSync(join(dir, "plain"));
    const env = { PATH: process.env.PATH!, HOME: join(dir, "home"), TMPDIR: dir, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: join(dir, "herdr"), GIT_CEILING_DIRECTORIES: dir };
    Bun.spawnSync(["python3", "-I", join(root, "bin/sidebar.py")], { env,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "abcd1234-0000", cwd: join(dir, "plain") })) });
    const calls = readFileSync(join(dir, "calls"), "utf8");
    expect(calls).toContain("--token repo=\uf07b no git");
    expect(calls).toContain("--clear-token repostate");
    expect(calls).toContain("--token tree1=└");
    expect(calls).toContain("--token wsrepo=\uf07b no git");
    expect(calls).toContain("--source steading-run-w1:p1 --token wstree=└ --clear-token wsrun");
  });

  test("a shell inside the repository's .git (a wanjang run folder) still shows the repository", () => {
    const { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-ingit-"));
    writeFileSync(join(dir, "herdr"), `#!/bin/sh
echo "$@" >> ${dir}/calls
[ "$1 $2" = "pane get" ] && echo '{"result":{"pane":{"workspace_id":"w1","tab_id":"w1:t1"}}}'
exit 0
`);
    chmodSync(join(dir, "herdr"), 0o755);
    Bun.spawnSync(["git", "init", "-q", "-b", "main", join(dir, "repo")]);
    const run = join(dir, "repo", ".git", "wanjang", "2026-11-04-run");
    mkdirSync(run, { recursive: true });
    const env = { PATH: process.env.PATH!, HOME: join(dir, "home"), TMPDIR: dir, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: join(dir, "herdr"), GIT_CEILING_DIRECTORIES: dir };
    Bun.spawnSync(["python3", "-I", join(root, "bin/sidebar.py")], { env,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "abcd1234-0000", cwd: run })) });
    const calls = readFileSync(join(dir, "calls"), "utf8");
    expect(calls).toMatch(/--token repo=\S* ?main/);
    expect(calls).toContain("--token repostate=");
    expect(calls).toMatch(/--token wsrepo=\S* ?main/);
    expect(calls).not.toContain("no git");
  });

  test("the workspace's third Spaces row names its dev servers and running jobs, with guides in one source", () => {
    const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-wsrun-"));
    writeFileSync(join(dir, "herdr"), `#!/bin/sh
echo "$@" >> ${dir}/calls
[ "$1 $2" = "pane get" ] && echo '{"result":{"pane":{"workspace_id":"w1","tab_id":"w1:t1"}}}'
exit 0
`);
    chmodSync(join(dir, "herdr"), 0o755);
    Bun.spawnSync(["git", "init", "-q", join(dir, "repo")]);
    // A job that has run for a minute and not ended.
    const run = join(dir, "steading", "w1_p1", "jobs", "runs", "1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "start"), String(Math.floor(Date.now() / 1000) - 60));
    const env = { PATH: process.env.PATH!, HOME: join(dir, "home"), TMPDIR: dir, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: join(dir, "herdr") };
    const hook = () => Bun.spawnSync(["python3", "-I", join(root, "bin/sidebar.py")], { env,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "abcd1234-0000", cwd: join(dir, "repo") })) });
    hook();
    const calls = () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter((c) => c.startsWith("workspace report-metadata"));
    const [repo, runs] = calls();
    expect(repo).toContain("--clear-token wstree"); // the guide lives with the row it follows, in one source
    expect(runs).not.toContain("--ttl-ms");
    expect(runs).toContain("--token wstree=├ --token wsrun=⏳ 1 job --token wstree2=└");
    writeFileSync(join(run, "end"), String(Math.floor(Date.now() / 1000))); // the job ends: the row goes
    hook();
    expect(calls().length).toBe(3); // the repository source is unchanged, so only the run source goes out again
    const runs2 = calls()[2];
    expect(runs2).toContain("--token wstree=└ --clear-token wsrun --clear-token wstree2");
  });

  test("a job with no end whose output file is gone, or that started over 6 h ago, is not running", () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-cutoff-"));
    const now = Math.floor(Date.now() / 1000);
    const mk = (name: string, start: number, source?: string) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "start"), String(start));
      if (source) writeFileSync(join(dir, name, "source"), source);
    };
    writeFileSync(join(dir, "out"), "");
    mk("live", now - 60, join(dir, "out"));
    mk("gone", now - 60, join(dir, "missing"));
    mk("old", now - 7 * 3600, join(dir, "out"));
    const check = `
import sys
${PYLOAD}
a = sys.argv[1:]; sys.argv = sys.argv[:1]
v = load("v", a[0])
print([v.Jobs.shows(a[1] + "/" + n) for n in ("live", "gone", "old")])`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), dir], { env: { PATH: process.env.PATH!, STEADING_BASE: dir } });
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim()).toBe("[True, False, False]");
  });

  test("the deck's tasks come from Claude Code's folder, the talk only tells their story", () => {
    const { mkdtempSync, writeFileSync, mkdirSync, chmodSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-decktasks-"));
    const home = join(dir, "home");
    // The transcript made 19 tasks over two process lists; the folder holds the real two.
    const create = (subject: string) => JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(),
      message: { id: subject, content: [{ type: "tool_use", id: "u" + subject, name: "TaskCreate", input: { subject } }] } });
    const subjects = [...Array(17).keys()].map((i) => `old task ${i}`).concat(["new task a", "new task b"]);
    const projects = join(home, ".claude", "projects", "p");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "abcd1234-0000.jsonl"), subjects.map(create).join("\n") + "\n");
    const tasks = join(home, ".claude", "tasks", "session-abcd1234");
    mkdirSync(tasks, { recursive: true });
    [["new task a", "completed"], ["new task b", "in_progress"]].forEach(([subject, status], i) =>
      writeFileSync(join(tasks, `${i + 1}.json`), JSON.stringify({ id: String(i + 1), subject, status })));
    writeFileSync(join(dir, "herdr"), `#!/bin/sh\necho '{"result":{"pane":{"agent_session":{"agent":"claude","value":"abcd1234-0000"}}}}'\n`);
    chmodSync(join(dir, "herdr"), 0o755);
    const check = `
import sys
${PYLOAD}
args = sys.argv[1:]; sys.argv = sys.argv[:1]
v = load("v", args[0])
v.background = lambda fn, *a: fn(*a)
a = v.Agents()
a.find_session(); a.read_main()
d = a.digest
print(len(d.tasks), len(d.listed()), sorted(s for _, s in d.listed().values()))
print(len(d.story("1")), len(d.story("2")) )
a.session = ""; a.digest = v.Digest(); a.find_session()
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py")], {
      env: { PATH: process.env.PATH!, HOME: home, STEADING_BASE: join(dir, "w1_p1"), HERDR_BIN_PATH: join(dir, "herdr") },
    });
    expect(r.stderr.toString()).toBe("");
    const [counts, story] = r.stdout.toString().trim().split("\n");
    expect(counts).toBe("19 2 ['completed', 'in_progress']");
    expect(story).toBe("1 1");
  });

  test("a resumed conversation's tasks are found under the team its process started", () => {
    const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-resume-"));
    const home = join(dir, "home", ".claude");
    writeFileSync(join(dir, "herdr"), `#!/bin/sh\necho "$@" >> ${dir}/calls\n`);
    chmodSync(join(dir, "herdr"), 0o755);
    // The conversation is aaaa1111; the process that resumed it started at 5000 and made team bbbb2222.
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "42.json"), JSON.stringify({ sessionId: "aaaa1111-x", startedAt: 5000, cwd: "/p" }));
    mkdirSync(join(home, "teams", "session-bbbb2222"), { recursive: true });
    writeFileSync(join(home, "teams", "session-bbbb2222", "config.json"),
      JSON.stringify({ createdAt: 4200, members: [{ name: "team-lead", cwd: "/p" }] }));
    mkdirSync(join(home, "tasks", "session-bbbb2222"), { recursive: true });
    for (const [i, status] of ["completed", "pending"].entries())
      writeFileSync(join(home, "tasks", "session-bbbb2222", `${i + 1}.json`), JSON.stringify({ status }));
    const env = { PATH: process.env.PATH!, HOME: join(dir, "home"), TMPDIR: dir, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: join(dir, "herdr") };
    Bun.spawnSync(["python3", "-I", join(root, "bin/sidebar.py")], { env,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "aaaa1111-x", cwd: dir })) });
    expect(readFileSync(join(dir, "calls"), "utf8")).toContain("--token tasks= ▰▰▱▱▱ 1/2");
  });
});

describe("the run refresher", () => {
  test("reports wsrun with a ├ while a server runs, then clears it, sets └ and exits; one per workspace", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = require("node:fs").realpathSync(mkdtempSync(join(tmpdir(), "steading-run-")));
    const sock = join(dir, "herdr.sock");
    const log = join(dir, "log");
    writeFileSync(join(dir, "herdr"), "#!/bin/sh\nexit 0\n");
    require("node:fs").chmodSync(join(dir, "herdr"), 0o755);
    const fake = Bun.spawn(["python3", "-c", `
import socketserver, sys
class H(socketserver.StreamRequestHandler):
    def handle(self):
        open(sys.argv[2], "a").write(self.rfile.readline().decode())
        self.wfile.write(b'{"result":{}}\\n')
socketserver.UnixStreamServer(sys.argv[1], H).serve_forever()`, sock, log]);
    for (let i = 0; i < 50 && !existsSync(sock); i++) await Bun.sleep(100);
    const www = join(dir, "www");
    mkdirSync(www);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = Bun.spawn(["python3", "-m", "http.server", String(port)], { cwd: www, stdout: "ignore", stderr: "ignore" });
    const env = { PATH: process.env.PATH!, TMPDIR: dir, HERDR_SOCKET_PATH: sock, HERDR_BIN_PATH: join(dir, "herdr"), STEADING_RUN_EVERY: "0.5" };
    const refresher = () => Bun.spawn(["python3", "-I", join(root, "bin/steading_run.py"), "w1:p1", "w1", www, "1"], { env, stdout: "ignore", stderr: "ignore" });
    try {
      for (let i = 0; i < 50; i++) { // wait for the listener
        if (Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).stdout.length) break;
        await Bun.sleep(100);
      }
      const r1 = refresher();
      await Bun.sleep(2500);
      // Its reports (herdr_panes asks the same socket for the panes, too).
      const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        .filter((l) => l.method.endsWith("report_metadata")) : []);
      const last = () => lines().at(-1).params;
      expect(last().source).toBe("steading-run-w1:p1");
      expect(last().tokens).toEqual({ wstree: "├", wsrun: `▶ :${port}`, wstree2: "└" });
      expect(last()).not.toHaveProperty("ttl_ms");
      expect(lines().length).toBe(1); // 5 refreshes, one report: unchanged values are not re-sent
      // a second one for the same workspace exits at once and reports nothing
      const before = lines().length;
      const r2 = refresher();
      expect(await Promise.race([r2.exited, Bun.sleep(1500).then(() => -1)])).toBe(0);
      expect(r1.killed || r1.exitCode === null).toBe(true);
      server.kill();
      await server.exited;
      expect(await Promise.race([r1.exited, Bun.sleep(8000).then(() => -1)])).toBe(0);
      expect(last().tokens).toEqual({ wstree: "└", wsrun: null, wstree2: null });
      expect(existsSync(join(dir, "steading", "run-w1.pid"))).toBe(false);
      expect(before).toBeGreaterThan(0);
    } finally {
      server.kill();
      fake.kill();
    }
  }, 30000);
});

describe("a task's story", () => {
  test("enter on a task shows when it was made, the request, what Claude said as it moved, and mentions; esc or backspace goes back", () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-story-"));
    mkdirSync(join(dir, "base"), { recursive: true });
    const at = (s: number) => new Date(Date.now() - (100 - s) * 1000).toISOString();
    const say = (s: number, text: string) => ({ type: "assistant", timestamp: at(s), message: { content: [{ type: "text", text }] } });
    const call = (s: number, id: string, name: string, input: object) =>
      ({ type: "assistant", timestamp: at(s), message: { content: [{ type: "tool_use", id, name, input }] } });
    const result = (s: number, id: string, text: string) =>
      ({ type: "user", timestamp: at(s), message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
    const rows = [
      { type: "user", timestamp: at(1), message: { content: "fix the back button" } },
      call(2, "c1", "TaskCreate", { subject: "Fix the back button" }),
      result(3, "c1", "Task #4 created successfully: Fix the back button"), // the list's own number, not 1
      say(4, "On it."),
      call(5, "c2", "TaskUpdate", { taskId: "4", status: "in_progress" }),
      say(6, "Keeping the scroll position on back."),
      say(7, "Fix the back button is in review now."),
      call(8, "c3", "TaskUpdate", { taskId: "4", status: "completed" }),
      say(9, "Shipped."),
    ];
    const main = join(dir, "s1.jsonl");
    writeFileSync(main, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const check = `
import sys
${PYLOAD}
args = sys.argv[1:]; sys.argv = sys.argv[:1]
v = load("v", args[0])
v.background = lambda fn, *a: fn(*a)
a = v.Agents(); a.find_session = lambda: None; a.session = args[1]; a.read_main(); a.refresh()
show = lambda: [v.ANSI.sub("", l) for l in a.frame(70, 40)[0]]
a.list_key("\\r"); show()
keys = [k for k, _ in a.controls()]
a.control = keys.index("task:4"); show(); a.key("\\r"); p = show()
story = [l.strip("│ ") for l in p]
print(" | ".join(" ".join(s.split()) for s in story if s))
a.key("\\x7f"); show(); show()  # backspace goes back too
print(a.story(), a.controls()[a.control][0])
a.key("\\r"); show()  # open it again, then a click on its "← task" border goes back
top = next(i for i, l in enumerate(a.plain) if "← task" in l)
a.click(a.body_row + top - a.offset, 5); show(); show()
print(a.story())
a.key("\\r"); show(); a.focus = "list"; show()  # the story shows while the list has the focus too: its "← task" still goes back
top = next(i for i, l in enumerate(a.plain) if "← task" in l)
a.click(a.body_row + top - a.offset, 5); show()
print(a.runs[a.tab].task_open)
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), main], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(dir, "base") },
    });
    expect(r.stderr.toString()).toBe("");
    const [story, back, clicked, clickedFromList] = r.stdout.toString().trim().split("\n");
    for (const part of ["← task · done", "created | you fix the back button", "created | Claude On it.",
                        "started | Claude Keeping the scroll position on back.",
                        "mentioned | Claude Fix the back button is in review now.", "done | Claude Shipped."])
      expect(story).toContain(part);
    expect(back).toBe("None task:4");
    expect(clicked).toBe("None");
    expect(clickedFromList).toBe("None");
  });
});

describe("a run folder emptied by the system's temp cleanup", () => {
  test("is not listed, so it never reads as in progress", () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-emptied-"));
    const now = String(Math.floor(Date.now() / 1000));
    const done = join(dir, "deploy", "runs", "1");
    mkdirSync(done, { recursive: true });
    for (const [f, v] of [["cmd", "vercel --prod"], ["rc", "0"], ["start", now], ["end", now]]) writeFileSync(join(done, f), v + "\n");
    mkdirSync(join(dir, "deploy", "runs", "2"));  // emptied: no files left
    mkdirSync(join(dir, "deploy", "runs", "3"));  // only its start left
    writeFileSync(join(dir, "deploy", "runs", "3", "start"), now + "\n");
    const check = `
import sys
${PYLOAD}
args = sys.argv[1:]; sys.argv = sys.argv[:1]
v = load("v", args[0])
t = v.Runs("deploy"); t.refresh()
print(*[r.n for r in t.runs])
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py")], {
      env: { PATH: process.env.PATH!, STEADING_BASE: dir },
    });
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim()).toBe("1");
  });
});

describe("search in a run's output", () => {
  test("typing a search leaves the header alone, and the search lands in the log even from the command lines", () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-search-"));
    const run = join(dir, "test", "runs", "1");
    mkdirSync(run, { recursive: true });
    const now = String(Math.floor(Date.now() / 1000));
    for (const [f, v] of [["cmd", "bun test"], ["rc", "0"], ["start", now], ["end", now], ["cwd", "/tmp"]]) writeFileSync(join(run, f), v + "\n");
    writeFileSync(join(run, "log"), ["alpha", "beta", "needle here", "gamma"].join("\n") + "\n");
    const check = `
import sys, time
${PYLOAD}
args = sys.argv[1:]; sys.argv = sys.argv[:1]
v = load("v", args[0])
v.background = lambda fn, *a: fn(*a)
t = v.Runs("test")
for _ in range(40):
    t.refresh(); t.frame(50, 30); time.sleep(0.05)
    if t.runs and t.plain and "gamma" in t.plain[-1]: break
show = lambda: [v.ANSI.sub("", l) for l in t.frame(50, 30)[0]]
t.focus, t.follow = "log", False
t.switch_part()                      # the cursor on the command lines
print(t.part)
before = show()
for k in "/nee": t.key(k)
print(show() == before)              # nothing in the box moved while typing
t.key("\\r")
print(t.part, t.plain[t.cy])         # found in the log
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py")], {
      env: { PATH: process.env.PATH!, STEADING_BASE: dir },
    });
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim().split("\n")).toEqual(["head", "True", "log needle here"]);
  });
});

describe("a long log line", () => {
  test("unfolds under itself while the cursor is on it, stays put while selecting, and clicks below it land on their own lines", () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-unfold-"));
    const run = join(dir, "test", "runs", "1");
    mkdirSync(run, { recursive: true });
    const now = String(Math.floor(Date.now() / 1000));
    for (const [f, v] of [["cmd", "bun test"], ["rc", "0"], ["start", now], ["end", now], ["cwd", "/tmp"]]) writeFileSync(join(run, f), v + "\n");
    const long = "AssertionError: expected 401 to be 200 // Object.is equality at src/middleware/auth.test.ts:41:7 in the refresh-token rotation case";
    writeFileSync(join(run, "log"), ["one", "two", long, "three", "four"].join("\n") + "\n");
    const check = `
import sys, time
${PYLOAD}
args = sys.argv[1:]; sys.argv = sys.argv[:1]  # the viewer takes its base from argv, else STEADING_BASE
v = load("v", args[0])
v.background = lambda fn, *a: fn(*a)
t = v.Runs("test")
for _ in range(40):
    t.refresh(); t.frame(50, 30); time.sleep(0.05)
    if t.runs and t.plain and t.plain[-1] == "four": break
show = lambda: [v.ANSI.sub("", l) for l in t.frame(50, 30)[0]]
t.focus, t.follow, t.cx = "log", False, 0
t.cy = 1; p = show(); print(t.unfold, any(l.rstrip("│ ").endswith("case") for l in p))  # cut: its end is not shown
t.cy = 2; p = show(); print(t.unfold, any(l.rstrip("│ ").endswith("case") for l in p))  # unfolded: its end shows
row = next(i for i, l in enumerate(p) if "three" in l) + 2  # +2: the frame starts under the tab strip
print(t.plain[t.log_line(row)])
# A selection started on it keeps it unfolded while the cursor moves on: the rows stay put.
t.cy, t.cx = 2, 0; show(); t.key("v"); before = show(); t.key("j"); t.key("j"); after = show()
print(t.unfold[0], [l.split("│")[1:2] for l in before if "three" in l] == [l.split("│")[1:2] for l in after if "three" in l])
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py")], {
      env: { PATH: process.env.PATH!, STEADING_BASE: dir },
    });
    expect(r.stderr.toString()).toBe("");
    const [cut, open, clicked, selecting] = r.stdout.toString().trim().split("\n");
    expect(cut).toBe("None False");
    expect(open).toMatch(/^\(2, [2-9]\) True$/); // line 2, its rest on the rows under it
    expect(clicked).toBe("three");
    expect(selecting).toBe("2 True");
  });
});

describe("a resumed background subagent", () => {
  test("is at work again when it writes after the notification that said it was done", () => {
    const { mkdtempSync, writeFileSync, mkdirSync, utimesSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "steading-resume-agent-"));
    const main = join(dir, "s1.jsonl");
    const subs = join(dir, "s1", "subagents");
    mkdirSync(subs, { recursive: true });
    const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const note = (id: string) => `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>`;
    for (const id of ["back", "gone"]) {
      writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify({ description: id, requestShape: "background", spawnDepth: 1 }));
      writeFileSync(join(subs, `agent-${id}.jsonl`), JSON.stringify({ type: "user", timestamp: at(300), message: { content: "go" } }) + "\n");
    }
    // Both were reported done 2 minutes ago; "back" was then sent a message and is writing now.
    writeFileSync(main, [{ type: "user", timestamp: at(120), message: { content: note("back") } },
                         { type: "user", timestamp: at(120), message: { content: note("gone") } }].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const old = new Date(Date.now() - 200 * 1000);
    utimesSync(join(subs, "agent-gone.jsonl"), old, old);
    const check = `
import sys, time
${PYLOAD}
args = sys.argv[1:]; sys.argv = sys.argv[:1]
v = load("v", args[0])
v.background = lambda fn, *a: fn(*a)
s = v.Agents(); s.find_session = lambda: None; s.session = args[1]
s.read_main(); s.refresh(); s.refresh()
print(*sorted(r.id for r in s.runs))
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), main], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(dir, "base") },
    });
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim()).toBe("back main");
  });
});

describe("the agents section keeps what it parsed of a transcript", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, renameSync, truncateSync, readFileSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const line = (o: object) => JSON.stringify(o) + "\n";
  const at = "2026-01-01T00:00:00Z";
  const result = (id: string) => line({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id }] } });
  const note = (id: string) => line({ type: "queue-operation", timestamp: at, content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` });
  const call = (id: string) => line({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: "/a" } }] } });

  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "steading-cache-"));
    const main = join(dir, "s1.jsonl");
    const sagent = join(dir, "s1", "subagents", "agent-aaa.jsonl");
    mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
    writeFileSync(join(dir, "s1", "subagents", "agent-aaa.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "t1" }));
    writeFileSync(sagent, call("x1") + call("x2"));
    writeFileSync(main, result("t1") + note("bbb") + result("t2"));
    return { dir, main, sagent, cache: join(dir, "cache") };
  };
  // One deck's whole parse in a fresh process: the state it ends with and how many rows it parsed.
  const run = (dir: string, main: string, cache: string, chunk = 0) => {
    const code = `
import json, sys, time
${PYLOAD}
v = load("v", sys.argv[1])
v.background = lambda fn, *a: fn(*a)
if int(sys.argv[3]):
    sys.modules["transcripts"].CHUNK = int(sys.argv[3])  # the parser reads in its own chunks
n = [0]; loads = json.loads
def counted(raw, *a, **k):
    n[0] += isinstance(raw, bytes)
    return loads(raw, *a, **k)
json.loads = counted
s = v.Agents(); s.session, s.looked = sys.argv[2], time.time()
while True:  # one chunk a read: read on to the end, as the ticks do
    at = s.read_to; s.read_main()
    if s.read_to == at:
        break
s.refresh()
sub = next(r for r in s.every if r.id == "aaa")
dump = lambda o: json.dumps(o.__dict__, sort_keys=True, default=lambda x: sorted(x) if isinstance(x, set) else str(type(x)))
print(json.dumps({"parsed": n[0], "read_to": s.read_to, "results": s.results, "notified": s.notified,
                  "main": dump(s.digest), "sub": dump(sub.digest), "calls": sub.calls}))
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", code, join(root, "bin/viewer.py"), main, String(chunk)], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(dir, "base"), STEADING_CACHE: cache },
    });
    expect(r.stderr.toString()).toBe("");
    return JSON.parse(r.stdout.toString());
  };
  // The same files parsed with no cache at all.
  const full = (dir: string, main: string) => run(dir, main, join(dir, "nocache"));
  const same = (a: any, b: any) => expect({ ...a, parsed: 0 }).toEqual({ ...b, parsed: 0 });

  test("a second deck parses only the rows added since the first", () => {
    const { dir, main, sagent, cache } = setup();
    expect(run(dir, main, cache).parsed).toBe(5);
    expect(readdirSync(cache).length).toBe(2); // the main transcript and the subagent
    appendFileSync(main, result("t3") + note("ccc"));
    appendFileSync(sagent, call("x3"));
    const second = run(dir, main, cache);
    expect(second.parsed).toBe(3);
    const fresh = full(dir, main);
    expect(fresh.parsed).toBe(8);
    same(second, fresh);
    expect(second.calls).toBe(3);
    expect(Object.keys(second.results).sort()).toEqual(["t1", "t2", "t3"]);
  });

  test("a transcript read in small chunks ends as one read whole", () => {
    const { dir, main, sagent } = setup();
    appendFileSync(main, result("t3") + note("ccc"));
    appendFileSync(sagent, call("x3") + call("x4"));
    const chunked = run(dir, main, join(dir, "chunked"), 10); // shorter than a line: a line a read
    same(chunked, full(dir, main));
    expect(chunked.calls).toBe(4);
    expect(Object.keys(chunked.results).sort()).toEqual(["t1", "t2", "t3"]);
  });

  test("a transcript that was replaced, cut short or changed before the offset is parsed from scratch", () => {
    const cases: Record<string, (main: string, dir: string) => void> = {
      replaced: (main, dir) => {
        writeFileSync(join(dir, "new"), result("n1") + result("n2") + note("ddd") + result("n3") + result("n4"));
        renameSync(join(dir, "new"), main);
      },
      truncated: (main) => truncateSync(main, result("t1").length),
      edited: (main) => writeFileSync(main, readFileSync(main, "utf8").replace("t2", "u2") + result("t3")), // same inode
    };
    for (const [name, change] of Object.entries(cases)) {
      const { dir, main, cache } = setup();
      run(dir, main, cache);
      change(main, dir);
      const again = run(dir, main, cache);
      const fresh = full(dir, main);
      same({ name, ...again }, { name, ...fresh });
      // the main transcript was read whole again; only the untouched subagent (2 rows) came from the cache
      expect({ name, parsed: again.parsed + 2 }).toEqual({ name, parsed: fresh.parsed });
    }
  });

  test("a corrupt cache is ignored", () => {
    const { dir, main, cache } = setup();
    run(dir, main, cache);
    for (const f of readdirSync(cache)) writeFileSync(join(cache, f), "\x00garbage\xff not a pickle");
    const again = run(dir, main, cache); // run() already demands an empty stderr
    same(again, full(dir, main));
    expect(again.parsed).toBe(5);
  });
});

test("a turn whose usage has null counts is read, not a crash", () => {
  // OpenRouter answers can carry "cache_read_input_tokens": null; one such line used to kill the
  // deck's subagent reader and keep every later subagent off the agents list.
  const code = `import sys, importlib.util as u
sys.argv = ["v", "/tmp"]
spec = u.spec_from_file_location("v", ${JSON.stringify(join(root, "bin/viewer.py"))})
m = u.module_from_spec(spec); spec.loader.exec_module(m)
d = m.Digest()
d.feed({"type": "assistant", "timestamp": "2026-10-25T00:00:00Z", "message": {"id": "x", "model": "claude-opus-5-5", "content": [], "usage": {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": None, "cache_creation_input_tokens": None}}})
print(d.usage["cache"], end="")`;
  const out = Bun.spawnSync(["python3", "-I", "-c", code]);
  expect(out.stderr.toString()).toBe("");
  expect(out.stdout.toString()).toBe("0");
});

test("an agent's first row ends with its model, and its effort when set", () => {
  const code = `import sys, types, importlib.util as u
sys.argv = ["v", "/tmp"]
spec = u.spec_from_file_location("v", ${JSON.stringify(join(root, "bin/viewer.py"))})
m = u.module_from_spec(spec); spec.loader.exec_module(m)
run = lambda effort: types.SimpleNamespace(model=lambda: "opus-5-5", digest=types.SimpleNamespace(effort=effort))
print(m.AgentRun.top_right(run("high")) + "|" + m.AgentRun.top_right(run("")), end="")`;
  const out = Bun.spawnSync(["python3", "-I", "-c", code]);
  expect(out.stderr.toString()).toBe("");
  expect(out.stdout.toString()).toBe("opus-5-5 · high|opus-5-5");
});

test("tasks list what is left first, then the done ones, newest first in each", () => {
  const code = `import sys, importlib.util as u
sys.argv = ["v", "/tmp"]
spec = u.spec_from_file_location("v", ${JSON.stringify(join(root, "bin/viewer.py"))})
m = u.module_from_spec(spec); spec.loader.exec_module(m)
d = m.Digest()
d.disk = [("1", "a", "completed"), ("2", "b", "pending"), ("3", "c", "in_progress"), ("4", "d", "completed"), ("5", "e", "pending"), ("10", "f", "in_progress")]
print(" ".join(d.listed()), end="")`;
  const out = Bun.spawnSync(["python3", "-I", "-c", code]);
  expect(out.stderr.toString()).toBe("");
  expect(out.stdout.toString()).toBe("10 3 5 2 4 1");
});

describe("the system tab reads the machine from fixed tool output", () => {
  // Call bin/viewer.py (and the bin modules it puts on the path) on fixed text; print JSON.
  const viewer = JSON.stringify(join(root, "bin/viewer.py"));
  const py = (body: string, env: Record<string, string> = {}) => {
    const code = `import sys, os, json, time, types, importlib.util as u
sys.argv = ["v", "/tmp"]
spec = u.spec_from_file_location("v", ${viewer})
m = u.module_from_spec(spec); spec.loader.exec_module(m)
import procs
${body}`;
    const r = Bun.spawnSync([Bun.which("python3")!, "-I", "-c", code], { env: { PATH: process.env.PATH!, ...env } });
    expect(r.stderr.toString()).toBe("");
    return JSON.parse(r.stdout.toString());
  };
  const { mkdtempSync, writeFileSync, chmodSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const me = process.getuid!();
  // Fake tools on PATH ahead of the real ones: each prints its fixed output.
  const fakeBin = (tools: Record<string, string>) => {
    const bin = mkdtempSync(join(tmpdir(), "steading-system-"));
    for (const [name, out] of Object.entries(tools)) {
      writeFileSync(join(bin, name), `#!/bin/sh\ncat <<'OUT'\n${out}\nOUT\n`);
      chmodSync(join(bin, name), 0o755);
    }
    return bin;
  };

  test("Linux: /proc/stat per core and /proc/meminfo; CPU % between two samples", () =>
    expect(py(`print(json.dumps([m.proc_cores("cpu  1 2 3 4\\ncpu0 100 5 50 800 20 3 2 0 9 0\\ncpu1 10 0 10 80 0 0 0 0\\nintr 5"),
                    m.core_pcts([(160, 980), (20, 100)], [(260, 1180), (20, 200)]),
                    m.proc_mem("MemTotal:       16000 kB\\nMemFree:  1000 kB\\nMemAvailable:   6000 kB\\n")]))`))
      .toEqual([[[160, 980], [20, 100]], [50, 0], [10000 * 1024, 16000 * 1024]]));

  test("macOS: vm_stat as Activity Monitor's memory used", () =>
    expect(py(`print(json.dumps(m.vm_stat_used('''Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   205379.
Pages active:                                 763488.
Pages wired down:                            1280467.
Pages purgeable:                                8599.
"Translation faults":                    30984969851.
Anonymous pages:                             1004757.
Pages occupied by compressor:                1054215.
''')))`)).toBe(16384 * (1004757 - 8599 + 1280467 + 1054215)));

  test("macmon: the last JSON line's GPU %, power and temperatures; nothing from junk", () =>
    expect(py(`line = json.dumps({"all_power": 30.9, "gpu_usage": [551, 0.25], "temp": {"cpu_temp_avg": 85.7, "gpu_temp_avg": 65.6}})
print(json.dumps([m.macmon_stats('{"all_power": 1}\\n' + line + "\\n"), m.macmon_stats(""), m.macmon_stats("not json")]))`))
      .toEqual([{ gpu: 25, watts: 30.9, cpu_temp: 85.7, gpu_temp: 65.6 }, {}, {}]));

  test("ps rows: names with spaces, macOS and Linux CPU times, control characters shown as ?; lsof's working folders", () =>
    expect(py(`print(json.dumps([procs.ps_table("""claude.exe         101     9   501 levx               3.4 784112   7:57.90 claude --resume abc
sshd               202     1     0 root               0.0   1024 1-02:03:04 /usr/sbin/sshd -D
Google Chrome He   303     1   501 levx               1.5   2048 00:01:23 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
evil               404     1   501 levx               0.0   1024 0:00.01 x \x1b]0;pwned\x07 \x7fy
garbage"""), m.lsof_cwds("p101\\nfcwd\\nn/Users/me/work/steading\\np202\\nfcwd\\nn/\\n")]))`))
      .toEqual([{ "101": ["claude.exe", "101", "9", 501, "levx", 3.4, 784112 * 1024, 477.9, "claude --resume abc"],
                  "202": ["sshd", "202", "1", 0, "root", 0, 1024 * 1024, 93784, "/usr/sbin/sshd -D"],
                  "303": ["Google Chrome He", "303", "1", 501, "levx", 1.5, 2048 * 1024, 83, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
                  "404": ["evil", "404", "1", 501, "levx", 0, 1024 * 1024, 0.01, "x ?]0;pwned? ?y"] }, // control characters never reach the screen
                { "101": "steading", "202": "/" }]));

  test("a Claude session is its claude and all under it; Chrome's claude.exe helper, its bundled ugrep and a nested claude are not sessions", () =>
    expect(py(`P = lambda name, pid, ppid, args: procs.Proc(name, pid, ppid, 501, "me", 0.0, 0, 0.0, args)
table = {p.pid: p for p in [P("zsh", "9", "1", "-zsh"), P("claude.exe", "10", "9", "claude"), P("node", "11", "10", "node mcp.js"),
         P("zsh", "12", "11", "zsh -c x"), P("claude", "13", "12", "claude -p hi"), P("claude.exe", "20", "1", "/x/claude.exe --chrome-native-host"),
         P("claude.exe", "30", "1", "ugrep -r foo .")]}
print(json.dumps([{k: sorted(v) for k, v in procs.sessions(table).items()}, procs.usage_text(13.0, 0.66 * 2**30), procs.usage_text(2.4, 0)]))`))
      .toEqual([{ "10": ["11", "12", "13"] }, "15% 0.7G", "0% 0.0G"]));

  test("the Program column: .exe dropped, a multi-call binary by its argv0, never a path, a login shell's dash or a cut name", () =>
    expect(py(`P = lambda name, args: procs.Proc(name, "1", "0", 501, "me", 0.0, 0, 0.0, args)
print(json.dumps([procs.program(p) for p in [P("claude.exe", "claude --resume x"), P("claude.exe", "ugrep -r foo ."),
      P("claude.exe", "/x/claude-code/bin/claude.exe --chrome-native-host"), P("zsh", "-zsh"), P("node", "node server.js"),
      P("Google Chrome He", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper"), P("Python", "/opt/bin/python3.12 x.py")]]))`))
      .toEqual(["claude", "ugrep", "claude", "zsh", "node", "Google Chrome He", "Python"]));

  test("install hints: brew for btop and macmon on macOS, the distro's btop on Linux, never macmon off macOS", () =>
    expect(py(`h = m.install_hint
print(json.dumps([h("darwin", set()), h("darwin", {"btop"}), h("darwin", {"btop", "macmon"}),
                  h("linux", set(), 'ID=ubuntu\\nID_LIKE=debian'), h("linux", set(), 'ID="fedora"'), h("linux", set(), "ID=arch"),
                  h("linux", set(), ""), h("linux", {"btop"}), h("freebsd14", set())]))`))
      .toEqual(["brew install btop macmon", "brew install macmon", "", "sudo apt install btop", "sudo dnf install btop",
                "sudo pacman -S btop", "sudo apt install btop · sudo dnf install btop · sudo pacman -S btop", "",
                "install btop with your package manager"]));

  // A session (101) with a node and a shell under it, a dev server the shell started (555, with a worker 556), a second
  // session, Chrome's helper, root's process.
  const PS = [
    `claude.exe   101     1 ${me} me    3.0 1024 0:01.00 claude`,
    `node         201   101 ${me} me   30.0 4096 0:01.00 node mcp.js`,
    `zsh          202   201 ${me} me    1.0 1024 0:01.00 zsh -c ls`,
    `claude.exe   203   101 ${me} me    0.0    0 0:00.00 ugrep -r foo .`,
    `claude.exe   102     1 ${me} me    9.0 2048 0:02.00 claude --resume x`,
    `claude.exe   103     1 ${me} me   40.0 2048 0:02.00 /Users/me/claude-code/bin/claude.exe --chrome-native-host`,
    `node         555   202 ${me} me   20.0 8192 0:09.00 node server.js`,
    `node         556   555 ${me} me    2.0 1024 0:01.00 node worker.js`,
    `other        777     1     0 root 50.0 9216 0:09.00 other --flag`].join("\n");
  const SYSTEM = `m.cwd_names = lambda pids: {"101": "alpha", "102": "beta"}  # lsof and /proc are read in tests of their own
s = m.System(types.SimpleNamespace(found=[("3000", "555", "node server.js")]))
s.stats = s.measure(None)
plain = lambda cols=90: [m.ANSI.sub("", l).strip("│ ") for l in s.frame(cols, 40)[0]]
pids = lambda: [r.pid for r in s.listed]
m.System.share = lambda self: None  # draw this sample, take no other`;

  test("the GPU and power rows come from macmon on macOS only; a bar for each core", () => {
    const bin = fakeBin({ ps: PS, sysctl: "68719476736", vm_stat: "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nAnonymous pages: 1000000.",
                          macmon: JSON.stringify({ all_power: 30.9, gpu_usage: [551, 0.25], temp: { cpu_temp_avg: 85.7, gpu_temp_avg: 65.6 } }) });
    for (const platform of ["darwin", "linux"]) {
      const lines: string[] = py(`m.PLATFORM = "${platform}"
${SYSTEM}
time.sleep(0.5)  # macmon keeps running: its first line comes in a moment after it starts
m.core_ticks = lambda: [(10, 100), (40, 100)]
s.stats = s.measure((time.time() - 2, [(0, 50), (0, 50)], {}))
print(json.dumps(plain()))`, { PATH: `${bin}:/usr/bin:/bin` });
      expect(lines.some(l => l.startsWith("gpu ") || l.startsWith("power "))).toBe(platform === "darwin");
      expect(lines.join("\n")).not.toContain(platform === "darwin" ? "apt" : "macmon");
      expect(lines.find(l => l.startsWith("cores"))).toMatch(/^cores +█+ +20 █+ +80$/);
      expect(lines).toContainEqual(expect.stringMatching(/^cpu +█+ 50%/));
    }
  });

  test("every process listed, a session one row summed over what runs under it (its dev servers apart), unfolded with enter; u and s; the selection a row, the scroll fixed", () => {
    const bin = fakeBin({ ps: PS });
    const [byCpu, unfolded, mine, byMem, session, kept, fixed, gone]: any[] = py(`m.PLATFORM = "linux"
${SYSTEM}
by_cpu = plain()
s.move(pids().index("101")); s.key("\\r"); unfolded = plain()
s.key("\\r"); s.key("u"); plain(); mine = pids(); s.key("u")
s.key("s"); plain(); by_mem = pids()
session = [l for l in s.frame(90, 40)[0] if " 101 " in m.ANSI.sub("", l)][0]
s.key("s"); plain(); s.move(pids().index("555")); s.key("s"); plain(); kept = [pids()[s.at], s.at]
s.listed = s.rows(); s.place(2); s.move(4); s.key("s"); s.listed = s.rows(); s.place(2); fixed = [s.top, s.at]
for pid in ("556", "103", "102"):
    s.stats["procs"].pop(pid)
s.listed = s.rows(); s.place(2); gone = [s.top, s.at, pids()[s.at]]
print(json.dumps([by_cpu, unfolded, mine, by_mem, session, kept, fixed, gone]))`, { PATH: `${bin}:/usr/bin:/bin` });
    const rows = (ls: string[]) => ls.filter(l => /^\d+ /.test(l));
    expect(rows(byCpu).map(l => l.split(" ")[0])).toEqual(["777", "103", "101", "555", "102", "556"]);
    const row = (ls: string[], pid: string) => rows(ls).find(l => l.startsWith(pid + " "))!;
    expect(row(byCpu, "101")).toMatch(/^101 ▸ claude +alpha · claude +me +6M +34\.0$/); // 3 + 30 + 1, 1K + 4K + 1K
    expect(row(byCpu, "555")).toContain(":3000 · node server.js");
    expect(row(byCpu, "103")).not.toContain("·");
    expect(byCpu).toContainEqual(expect.stringMatching(/─ processes · 6 · all users · by cpu ─/));
    expect(byCpu).toContainEqual(expect.stringMatching(/^Pid +Program +Command +User +MemB +Cpu%$/));
    expect(rows(unfolded).map(l => l.split(/ +/).slice(0, 2).join(" ")))
      .toEqual(["777 other", "103 claude", "101 ▾", "201 node", "202 zsh", "203 ugrep", "555 node", "102 ▸", "556 node"]);
    expect(mine).toEqual(["103", "101", "555", "102", "556"]);
    expect(byMem).toEqual(["777", "555", "101", "102", "103", "556"]);
    expect(session).toContain("\x1b[48;2;62;68;81m"); // the selection: raised on the list's ground
    expect(session).toContain("\x1b[38;2;143;168;210m"); // a session in the agents' colour
    expect(kept).toEqual(["102", 3]); // the selection is a row: after a re-sort, whoever lands on it
    expect(fixed).toEqual([3, 4]); // a re-sort scrolls nothing (2 rows show, the 5th selected)
    expect(gone).toEqual([1, 2, "555"]); // a shorter list: both kept within it
  });

  test("K asks in the hint line; only y sends SIGTERM, any other key (a tab's number too) keeps it; enter off a session does nothing, o opens", () => {
    const bin = fakeBin({ ps: PS });
    const out: any[] = py(`m.PLATFORM = "linux"
${SYSTEM}
sent = []
m.os.kill = lambda pid, sig: sent.append([pid, sig])
deck = types.SimpleNamespace(views=[s], section=0, settings_open=False)
plain(); s.move(pids().index("555"))
opened = []; s.open_tools = lambda: opened.append(1)
s.key("\\r"); enter = [opened[:], [k for k, _ in s.hints()][:2]]; s.key("o")
s.key("K"); asked = m.ANSI.sub("", " ".join(k + " " + w for k, w in s.hints()))
m.Deck.key(deck, "3"); kept = [sent[:], s.confirm, m.ANSI.sub("", s.hints()[0][0])]
s.key("K"); s.key("y")
s.move(pids().index("101")); s.key("K"); asked2 = s.confirm[:2]; s.key("y"); done = m.ANSI.sub("", s.hints()[0][0])
s.confirm = ("0", "x", m.identity("0")); s.key("y"); s.confirm = ("-1", "g", m.identity("-1")); s.key("y")  # 0 and below would signal process groups
print(json.dumps([enter, opened, asked, kept, sent, asked2, done, m.ANSI.sub("", s.hints()[0][0])]))`, { PATH: `${bin}:/usr/bin:/bin` });
    expect(out).toEqual([[[], ["K", "s"]], [1], "kill 555 node? y/n", [[], null, "kept 555 node"], [[555, 15], [101, 15]], ["101", "claude"],
                         "sent SIGTERM to 101 claude", "not ending -1 g"]);
  });

  test("a session unfolded with enter is followed by its pid, its rows kept in view, until a cursor key or its end", () => {
    const bin = fakeBin({ ps: PS });
    const out: any[] = py(`m.PLATFORM = "linux"
${SYSTEM}
def look(room=3):
    s.listed = s.rows(); s.place(room)
    return [s.top, s.at, pids()[s.at], s.following]
look(); s.move(2); s.key("\\r"); unfolded = look()  # 101 and its three rows: as many as fit in view
s.by = "mem"; s.stats["procs"].pop("777"); moved = look()  # a re-sort moves the session up a row: the cursor goes with it
s.key("j"); s.by = "cpu"; let_go = look()  # a cursor key lets it go: rows and a fixed scroll again
s.move(pids().index("101")); s.key("\\r"); s.key("\\r"); followed = s.following  # fold, unfold: followed again
s.stats["procs"].pop("101"); ended = look()  # it ends: rows again, the cursor on the row where it was
print(json.dumps([unfolded, moved, let_go, followed, ended]))`, { PATH: `${bin}:/usr/bin:/bin` });
    expect(out).toEqual([[2, 2, "101", "101"], [1, 1, "101", "101"], [1, 2, "201", null], "101", [1, 1, "555", null]]);
  });

  test("y ends the process K was pressed on, not the row's process at y; a pid that now names another process is not ended", () => {
    const bin = fakeBin({ ps: PS });
    const out: any[] = py(`m.PLATFORM = "linux"
${SYSTEM}
sent = []
m.os.kill = lambda pid, sig: sent.append([pid, sig])
starts = iter(["Mon 10:00 node", "Mon 10:00 node", "Mon 10:00 node", "Mon 11:30 node"])
m.identity = lambda pid: next(starts)
plain(); s.move(pids().index("555")); s.key("K")
s.by = "mem"; plain()  # a new sample re-sorts: another process lands on the selected row
s.key("y"); first = [sent[:], m.ANSI.sub("", s.hints()[0][0])]
s.move(pids().index("555")); s.key("K"); s.key("y")  # by y, pid 555 has ended and been given to another process
print(json.dumps([first, sent, m.ANSI.sub("", s.hints()[0][0])]))`, { PATH: `${bin}:/usr/bin:/bin` });
    expect(out).toEqual([[[[555, 15]], "sent SIGTERM to 555 node"], [[555, 15]], "555 node is no longer that process: not ended"]);
  });

  test("when ps cannot say what a process is, K asks nothing and y ends nothing", () => {
    const bin = fakeBin({ ps: PS });
    const out: any[] = py(`m.PLATFORM = "linux"
${SYSTEM}
sent = []
m.os.kill = lambda pid, sig: sent.append([pid, sig])
plain(); s.move(pids().index("555"))
m.identity = lambda pid: ""  # ps fails when K is pressed
s.key("K"); at_k = [s.confirm, m.ANSI.sub("", s.hints()[0][0])]
answers = iter(["Mon 10:00 node", ""])  # ps answers at K, fails at y
m.identity = lambda pid: next(answers)
s.key("K"); asked = s.confirm is not None; s.key("y")
print(json.dumps([at_k, asked, sent, m.ANSI.sub("", s.hints()[0][0])]))`, { PATH: `${bin}:/usr/bin:/bin` });
    expect(out).toEqual([[null, "cannot identify 555 node: not ended"], true, [], "555 node is no longer that process: not ended"]);
  });

  test("o goes to the herdr workspace named system, or makes it: btop wide, macmon narrow beside it", () => {
    const dir = mkdtempSync(join(tmpdir(), "steading-herdr-"));
    const log = join(dir, "calls");
    const herdr = (spaces: string) => {
      writeFileSync(join(dir, "herdr"), `#!/bin/sh
echo "$*" >> ${log}
case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":${spaces}}}' ;;
  "workspace create") echo '{"result":{"root_pane":{"pane_id":"w9:p1"}}}' ;;
  "pane split") echo '{"result":{"pane":{"pane_id":"w9:p2"}}}' ;;
  *) echo '{"result":{}}' ;;
esac
`);
      chmodSync(join(dir, "herdr"), 0o755);
      writeFileSync(log, "");
    };
    const open = (macmon: string) => py(`s = m.System(types.SimpleNamespace(found=[]))
s.open_workspace(${macmon})
print(json.dumps(open(${JSON.stringify(log)}).read().splitlines()))`, { HERDR_BIN_PATH: join(dir, "herdr"), HOME: dir });
    herdr("[]");
    expect(open("True")).toEqual(["workspace list", `workspace create --cwd ${dir} --label system --focus`,
                                  "pane split w9:p1 --direction right --ratio 0.7 --no-focus", "pane run w9:p2 macmon", "pane run w9:p1 btop"]);
    herdr("[]");
    expect(open("False")).toEqual(["workspace list", `workspace create --cwd ${dir} --label system --focus`, "pane run w9:p1 btop"]);
    herdr('[{"workspace_id":"w3","label":"system"}]');
    expect(open("True")).toEqual(["workspace list", "workspace focus w3"]);
  });

  test("the sidebar's $usage: a session's tree summed, the CPU it used since the last round, rounded", () => {
    const code = `import sys, json, importlib.util as u
spec = u.spec_from_file_location("usage", ${JSON.stringify(join(root, "bin/usage.py"))})
m = u.module_from_spec(spec); spec.loader.exec_module(m)
import procs
P = lambda name, pid, ppid, cpu, rss, secs, args: procs.Proc(name, pid, ppid, 501, "me", cpu, rss, secs, args)
first = {p.pid: p for p in [P("claude.exe", "10", "1", 4.0, 2**29, 100.0, "claude"), P("node", "11", "10", 3.0, 2**28, 50.0, "node mcp.js")]}
later = {p.pid: p for p in [P("claude.exe", "10", "1", 4.0, 2**29, 103.0, "claude"), P("node", "11", "10", 3.0, 2**28, 51.0, "node mcp.js")]}
was = {}
print(json.dumps([m.values(first, {"w1:p1": "10"}, was, 1000.0), m.values(later, {"w1:p1": "10"}, was, 1010.0)]))`;
    const r = Bun.spawnSync([Bun.which("python3")!, "-I", "-c", code], { env: { PATH: process.env.PATH!, STEADING_SIDEBAR_ICONS: "0" } });
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toEqual([{ "w1:p1": "5% 0.8G" }, { "w1:p1": "40% 0.8G" }]); // 7% by ps; then 4 s in 10 s
  });

  test("usage.py runs once: its pid file is made atomically, a dead or foreign pid in it is stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "steading-usage-"));
    const code = `import os, json, subprocess, importlib.util as u
spec = u.spec_from_file_location("usage", ${JSON.stringify(join(root, "bin/usage.py"))})
m = u.module_from_spec(spec); spec.loader.exec_module(m)
os.makedirs(m.BASE)
first, again = m.claim(), m.claim()  # this process is no usage.py, so its own pid reads stale
sleeper = subprocess.Popen(["sleep", "5"])
open(m.PIDFILE, "w").write(str(sleeper.pid)); foreign = [m.running(), m.claim()]
open(m.PIDFILE, "w").write("99999999"); dead = [m.running(), m.claim(), open(m.PIDFILE).read() == str(os.getpid())]
sleeper.kill()
print(json.dumps([first, again, foreign, dead]))`;
    const r = Bun.spawnSync([Bun.which("python3")!, "-I", "-c", code], { env: { PATH: process.env.PATH!, TMPDIR: dir + "/" } });
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toEqual([true, true, [false, true], [false, true, true]]);
  });

  test("a macmon that keeps dying is started again less and less often", () => {
    const bin = fakeBin({});
    const runs = join(bin, "runs");
    writeFileSync(join(bin, "macmon"), `#!/bin/sh\necho run >> ${runs}\n`);
    chmodSync(join(bin, "macmon"), 0o755);
    const out: any[] = py(`waits = []
for _ in range(3):
    before = m._macmon["wait"]
    m.macmon_line()
    for _ in range(100):  # until it has died and its wait is set (a new script's first run can be slow on macOS)
        if m._macmon["wait"] != before:
            break
        time.sleep(0.05)
    waits.append(m._macmon["wait"])
    m.macmon_line()  # too soon: no new start
    m._macmon["next"] = 0  # as if the wait were over
print(json.dumps([waits, len(open(${JSON.stringify(runs)}).read().split())]))`, { PATH: `${bin}:/usr/bin:/bin` });
    expect(out).toEqual([[2, 4, 8], 3]);
  });

  test("a macmon that ends, or is stopped when no longer asked for, is reaped, not left a zombie", () => {
    const bin = fakeBin({});
    writeFileSync(join(bin, "macmon"), `#!/bin/sh\n[ -n "$KEEP" ] || exit 0\nwhile :; do echo '{}'; sleep 0.05; done\n`);
    chmodSync(join(bin, "macmon"), 0o755);
    const reaped = (env: Record<string, string>) => py(`m.SAMPLE_SECS = 0.01  # asked for 0.05s at most
m.macmon_line()
p = m._macmon["proc"]
for _ in range(100):  # nothing calls poll(): only the reader thread can reap it
    if p.returncode is not None:
        break
    time.sleep(0.05)
print(json.dumps(p.returncode))`, { PATH: `${bin}:/usr/bin:/bin`, ...env });
    expect(reaped({})).toBe(0); // ended by itself
    expect(reaped({ KEEP: "1" })).toBe(-15); // stopped: SIGTERM
  });

  test("a deck restarted in place reaps the children its earlier run left as zombies", () => {
    const out = py(`import subprocess
pid = subprocess.Popen(["true"]).pid
time.sleep(0.3)  # ended, not waited for: a zombie, as after the exec
subprocess._active.clear()  # the new run has no Popen object for it
was = os.popen(f"ps -o stat= -p {pid}").read().strip()
m.reap()
print(json.dumps([was[:1], os.popen(f"ps -o stat= -p {pid}").read().strip()]))`);
    expect(out).toEqual(["Z", ""]);
  });

  test("focus comes from herdr's focus events over one held connection, with no process started", () => {
    const sock = join(mkdtempSync(join(tmpdir(), "steading-focus-")), "herdr.sock");
    const out = py(`import socket, threading, subprocess
srv = socket.socket(socket.AF_UNIX); srv.bind(${JSON.stringify(sock)}); srv.listen(8)
state, subs = {"focused": False}, []
def serve():
    while True:
        c, _ = srv.accept()
        req = json.loads(c.makefile("rb").readline())
        if req["method"] == "events.subscribe":
            subs.append(req["params"]["subscriptions"])
            c.sendall(b'{"id":"x","result":{"type":"subscription_started"}}\\n'); subs.append(c)
        else:
            c.sendall((json.dumps({"id": req["id"], "result": {"pane": {"focused": state["focused"]}}}) + "\\n").encode()); c.close()
threading.Thread(target=serve, daemon=True).start()
os.environ["HERDR_SOCKET_PATH"] = ${JSON.stringify(sock)}
spawned, orig = [], subprocess.Popen.__init__
def init(self, *a, **k):
    spawned.append(a[0]); orig(self, *a, **k)
subprocess.Popen.__init__ = init
m.background = lambda fn, *a: threading.Thread(target=fn, args=a, daemon=True).start()
def until(cond):
    for _ in range(200):
        if cond():
            return
        time.sleep(0.02)
d = m.Deck()
for v in d.views:
    v.refresh = lambda: False
d.refresh()
until(lambda: m.FOCUS["pane"] is False)
was = m.FOCUS["pane"]
state["focused"] = True
subs[1].sendall(b'{"event":"pane_focused","data":{"pane_id":"w1:p1"}}\\n')
until(lambda: m.FOCUS["pane"] is True)
for _ in range(5):
    d.refresh()
print(json.dumps([was, m.FOCUS["pane"], [t["type"] for t in subs[0]], len(subs), spawned]))`);
    expect(out).toEqual([false, true, ["pane.focused", "tab.focused", "workspace.focused"], 2, []]);
  });

  test("a focus change herdr reports wakes the main loop; a lost herdr is asked again 2s on, doubling to 30s", () => {
    const out = py(`m.WAKE[:] = os.pipe()
d = m.Deck()
got = [{"pane": {"focused": False}}, {"pane": {"focused": False}}]
m.herdr_api = lambda *a: got.pop(0) if got else {}
d.look_focus(); woke = bool(m.select.select([m.WAKE[0]], [], [], 0)[0])
os.read(m.WAKE[0], 99); d.look_focus(); again = bool(m.select.select([m.WAKE[0]], [], [], 0)[0])
waits = []
def sleep(s):
    waits.append(s)
    if len(waits) > 6:
        raise SystemExit
m.time.sleep = sleep
try:
    d.watch_focus("/nonexistent/herdr.sock")
except SystemExit:
    pass
print(json.dumps([woke, again, waits]))`);
    expect(out).toEqual([true, false, [2, 4, 8, 16, 30, 30, 30]]);
  });

  test("the deck waits a second between frames once three came out the same; the system tab until its sample", () => {
    const out = py(`d = types.SimpleNamespace(views=[types.SimpleNamespace()], section=0, still=0)
waits = [m.tick_wait(d)]
d.still = 3; waits.append(m.tick_wait(d))
d.views[0].fresh = (None, time.time()); waits.append(m.tick_wait(d))  # a row fading in
for due in (0.5, -1, 5):
    d.views = [types.SimpleNamespace(due=lambda: due)]; waits.append(m.tick_wait(d))
m.BASE = ${JSON.stringify(mkdtempSync(join(tmpdir(), "steading-still-")))}
m.background = lambda fn, *a: None
deck = m.Deck(); stills = []
sys.stdout = open(os.devnull, "w")
for change in (False, False, False, True):
    deck.settings_open = change
    deck.draw(); stills.append(deck.still)
sys.stdout = sys.__stdout__
print(json.dumps([[round(w, 2) for w in waits], stills]))`);
    expect(out).toEqual([[0.3, 1, 0.05, 0.5, 0.1, 1], [0, 1, 2, 0]]);
  });

  test("hidden, the servers scan every 10s (2s beside the system tab) and git every 30s", () => {
    const out = py(`m.background = lambda fn, *a: None
s = m.Servers(); s.scan = lambda: None
g = m.Git(); g.read_repo = lambda: None
seen = []
for kind in ("build", "servers", "system", "git"):
    m.SHOWN["kind"] = kind
    s.scanning, s.looked_at, g.reading, g.looked_at = False, time.time() - 5, False, time.time() - 5
    s.refresh(); g.refresh()
    seen.append([s.scanning, g.reading])
s.scanning, s.looked_at = False, time.time() - 11; m.SHOWN["kind"] = "build"; s.refresh()
print(json.dumps([seen, s.scanning]))`);
    expect(out).toEqual([[[false, false], [true, false], [true, false], [false, true]], true]);
  });

  test("every tab's data refreshes once a second, and a tab switched to at once", () => {
    const out = py(`m.background = lambda fn, *a: None
d = m.Deck(); n = [0] * len(d.views)
for i, view in enumerate(d.views):
    view.refresh = (lambda i: lambda: n.__setitem__(i, n[i] + 1))(i)
for _ in range(5):
    d.refresh()
d.hidden_at -= 1  # a second on
d.refresh()
first = list(n)
d.section = (d.section + 1) % len(d.views)
d.refresh(); d.refresh()
print(json.dumps([sorted(set(first)), n[d.section] - first[d.section]]))`);
    expect(out).toEqual([[2], 1]);
  });

  test("a spinner's tick writes only its row, from the frame last built; a key, a second or the tab's file builds it again", () => {
    const base = mkdtempSync(join(tmpdir(), "steading-diff-"));
    const out = py(`m.BASE = ${JSON.stringify(base)}
m.background = lambda fn, *a: None
d = m.Deck()
class View:
    kind, focus = "agents", "list"
    def __init__(self): self.built, self.file = 0, 0
    def frame(self, cols, rows):
        self.built += 1
        return [f"{m.spinner()} working", "still text", f"file {self.file}"], []
    def hints(self): return []
    def badge(self): return ("·", m.MUTED_RGB)
    def watch(self): return self.file
v = View(); d.views[d.section] = v
written = []
class Out:
    def write(self, s): written.append(s)
    def flush(self): pass
sys.stdout = Out()
t = [100.0]; m.time.time = lambda: t[0]
d.draw()                      # first: built, every row written
first = written[-1].count(";1H")
t[0] += 0.13; d.draw()        # the spinner turned: no build, one row
tick = (v.built, written[-1])
d.dirty = True; t[0] += 0.13; d.draw(); keyed = v.built      # a key: built again
t[0] += 1.0; d.draw(); clocked = v.built                     # a second on: built again
v.file = 1; t[0] += 0.01; d.draw(); watched = (v.built, "file 1" in written[-1])
sys.stdout = sys.__stdout__
rows = m.shutil.get_terminal_size()[1]
print(json.dumps([first == rows, tick[0], tick[1].count(";1H"), "working" in tick[1], "still text" in tick[1], keyed, clocked, watched]))`);
    expect(out).toEqual([true, 1, 1, true, false, 2, 3, [4, true]]);
  });

  test("a session whose transcript is not there yet is looked for again on the next look, not 30s later", () => {
    const home = mkdtempSync(join(tmpdir(), "steading-home-"));
    const out = py(`os.environ["HOME"] = ${JSON.stringify(home)}
os.makedirs(os.path.join(${JSON.stringify(home)}, ".claude", "projects", "p"))
m.herdr_api = lambda *a: {"pane": {"agent_session": {"agent": "claude", "value": "abc"}}}
a = m.Agents(); a.find_session(); before = a.session
open(os.path.join(${JSON.stringify(home)}, ".claude", "projects", "p", "abc.jsonl"), "w").write("{}\\n")
a.find_session()
print(json.dumps([before, os.path.basename(a.session)]))`);
    expect(out).toEqual(["", "abc.jsonl"]);
  });

  test("every row is written again on another tab, a new size, focus coming back and every 30s", () => {
    const base = mkdtempSync(join(tmpdir(), "steading-repaint-"));
    const out = py(`m.BASE = ${JSON.stringify(base)}
m.background = lambda fn, *a: None
d = m.Deck()
class View:
    focus = "list"
    def __init__(self, kind): self.kind = kind
    def frame(self, cols, rows): return ["same text"], []
    def hints(self): return []
    def badge(self): return ("·", m.MUTED_RGB)
d.views = [View(v.kind) for v in d.views]
written = []
class Out:
    def write(self, s): written.append(s.count(";1H"))
    def flush(self): pass
sys.stdout = Out()
t, size = [100.0], [os.terminal_size((60, 20))]
m.time.time = lambda: t[0]
m.shutil.get_terminal_size = lambda: size[0]
def step(change):
    change(); t[0] += 0.13; n = len(written); d.draw(); return written[n:]
steps = [step(lambda: None), step(lambda: None),                       # first: all; unchanged: nothing
         step(lambda: setattr(d, "section", 1)),                       # another tab
         step(lambda: size.__setitem__(0, os.terminal_size((61, 20)))),  # a new size
         step(lambda: setattr(d, "screen", None)),                     # focus back (the main loop drops it)
         step(lambda: None), step(lambda: t.__setitem__(0, t[0] + 30))]  # nothing; 30s on
sys.stdout = sys.__stdout__
print(json.dumps(steps))`);
    expect(out).toEqual([[20], [], [20], [20], [20], [], [20]]);
  });

  test("backspace (and ctrl+h) leaves a log or a detail as esc does; q too; in a list q is nothing and backspace itself", () => {
    const out = py(`inside, listed = types.SimpleNamespace(focus="log"), types.SimpleNamespace(focus="list")
print(json.dumps([[m.back_key(inside, k) for k in ("\\x7f", "\\x08", "q", "j")],
                  [m.back_key(listed, k) for k in ("\\x7f", "\\x08", "q", "j")], m.back_key(m.System(types.SimpleNamespace(found=[])), "\\x7f"),
                  [m.back_key(v, k, True) for v in (inside, listed) for k in ("\\x7f", "q")]]))`);
    // Over the settings popup, backspace is q there (it closes), whatever the tab behind it shows.
    expect(out).toEqual([["\x1b", "\x1b", "\x1b", "j"], ["\x7f", "\x08", null, "j"], "\x7f", ["q", "q", "q", "q"]]);
  });

  test("the subagents' transcripts are listed as glob lists them, again only when a folder changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "steading-list-"));
    const out = py(`import glob
d = ${JSON.stringify(dir)}
os.makedirs(d + "/workflows/w1")
for f in ("agent-a.jsonl", "agent-a.meta.json", "other.jsonl", "workflows/w1/agent-b.jsonl"):
    open(f"{d}/{f}", "w").close()
like_glob = lambda: sorted(glob.glob(f"{d}/agent-*.jsonl") + glob.glob(f"{d}/workflows/*/agent-*.jsonl"))
first = sorted(m.transcripts(d)) == like_glob()
calls, listdir = [0], os.listdir
os.listdir = lambda p: (calls.__setitem__(0, calls[0] + 1), listdir(p))[1]
m.transcripts(d); unchanged = calls[0]
time.sleep(0.01); open(f"{d}/agent-c.jsonl", "w").close()
print(json.dumps([first, unchanged, sorted(m.transcripts(d)) == like_glob(), len(m.transcripts(d))]))`);
    expect(out).toEqual([true, 0, true, 3]);
  });

  test("a sample shared with the other decks clears temp files a dead deck left over a minute ago", () => {
    const dir = mkdtempSync(join(tmpdir(), "steading-shared-"));
    const out = py(`m.SHARED = ${JSON.stringify(join(dir, "system.json"))}
for name, age in (("system.json.1", 120), ("system.json.2", 5)):
    open(m.SHARED[:-11] + name, "w").close(); os.utime(m.SHARED[:-11] + name, (time.time() - age, time.time() - age))
s = m.System(types.SimpleNamespace(found=[]))
s.measure = lambda was: {"cpu": 1.0}
s.sample()
print(json.dumps(sorted(os.listdir(${JSON.stringify(dir)}))))`);
    expect(out).toEqual(["system.json", "system.json.2"]);
  });

  test("a deck-style watcher restarts on a change to a bin/ module it imported", () => {
    const { cpSync } = require("node:fs");
    const bin = join(mkdtempSync(join(tmpdir(), "steading-bin-")), "bin");
    cpSync(join(root, "bin"), bin, { recursive: true });
    const code = `import os, sys
sys.path.insert(0, ${JSON.stringify(bin)})
import reexec, tasklist
fired = []
check = reexec.watcher(os.path.join(${JSON.stringify(bin)}, "viewer.py"), every=0, exec_=lambda *a: fired.append(a))
check(); quiet = len(fired)
t = os.stat(tasklist.__file__).st_mtime + 5
os.utime(tasklist.__file__, (t, t))
check()
print(quiet, len(fired))`;
    const r = Bun.spawnSync([Bun.which("python3")!, "-I", "-c", code], { env: { PATH: process.env.PATH! } });
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim()).toBe("0 1");
  });
});
