import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const hook = join(root, "bin/hook");

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
from importlib.machinery import SourceFileLoader
v = SourceFileLoader("v", sys.argv[1]).load_module()
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
from importlib.machinery import SourceFileLoader
v = SourceFileLoader("v", sys.argv[1]).load_module()
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
from importlib.machinery import SourceFileLoader
args = sys.argv[1:]; sys.argv = sys.argv[:1]
v = SourceFileLoader("v", args[0]).load_module()
v.background = lambda fn, *a: fn(*a)
s = v.Agents(); s.session, s.looked = args[1], time.time()
s.read_main(); s.refresh()
print(" | ".join(r.label() for r in reversed(s.runs)))
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), main], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(dir, "base") },
    });
    expect(r.stderr.toString()).toBe("");
    // Names in one column, then what each is doing (main: its request), lined up after the longest name.
    expect(r.stdout.toString().trim()).toBe(`${"main".padEnd(20)}  go |   dash-quality |   └ foreman-designer`);
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
from importlib.machinery import SourceFileLoader
args = sys.argv[1:]; sys.argv = sys.argv[:1]  # the viewer takes its base from argv, else STEADING_BASE
v = SourceFileLoader("v", args[0]).load_module()
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
from importlib.machinery import SourceFileLoader
args = sys.argv[1:]; sys.argv = sys.argv[:1]
v = SourceFileLoader("v", args[0]).load_module()
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
from importlib.machinery import SourceFileLoader
sys.argv = ["v", "/tmp"]
v = SourceFileLoader("v", "${join(root, "bin/viewer.py")}").load_module()
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
from importlib.machinery import SourceFileLoader
sys.argv = ["v", "/tmp"]
v = SourceFileLoader("v", "${join(root, "bin/viewer.py")}").load_module()
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

describe("herdr sidebar tokens", () => {
  test("the hook reports the agent's repository, context use and tasks, once per 3s; a subagent reports only $crew", () => {
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
    // A subagent at work while the main turn may be idle: "⠿ N" on the pane, lapsing on its own.
    expect(all.some((c) => c.startsWith("pane report-metadata w1:p1 --source steading-crew --token crew=⠿ 1 --ttl-ms 90000"))).toBe(true);
    // 170k of 200k: 85%, past 80%, so it goes out as $ctxhot.
    expect(calls[0]).toContain("--token repo=");
    expect(calls[0]).toContain("1 changed");
    expect(calls[0]).toContain("--token model=opus-5-5");
    expect(calls[0]).toContain("--clear-token ctx --token ctxhot=▰▰▰▰▱ 85%");
    expect(calls[0]).toContain("--token tasks=▰▰▱▱▱ 1/3");
    hook({ ...event, hook_event_name: "Stop" }); // the end of a turn always reports
    expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter((c) => c.includes("--source steading ")).length).toBe(2);
    expect(existsSync(join(dir, "steading", "w1_p1", "sidebar"))).toBe(true);
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
    expect(readFileSync(join(dir, "calls"), "utf8")).toContain("--token tasks=▰▰▱▱▱ 1/2");
  });
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
from importlib.machinery import SourceFileLoader
args = sys.argv[1:]; sys.argv = sys.argv[:1]
v = SourceFileLoader("v", args[0]).load_module()
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
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", check, join(root, "bin/viewer.py"), main], {
      env: { PATH: process.env.PATH!, STEADING_BASE: join(dir, "base") },
    });
    expect(r.stderr.toString()).toBe("");
    const [story, back, clicked] = r.stdout.toString().trim().split("\n");
    for (const part of ["← task · done", "created | you fix the back button", "created | Claude On it.",
                        "started | Claude Keeping the scroll position on back.",
                        "mentioned | Claude Fix the back button is in review now.", "done | Claude Shipped."])
      expect(story).toContain(part);
    expect(back).toBe("None task:4");
    expect(clicked).toBe("None");
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
from importlib.machinery import SourceFileLoader
args = sys.argv[1:]; sys.argv = sys.argv[:1]
v = SourceFileLoader("v", args[0]).load_module()
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
from importlib.machinery import SourceFileLoader
args = sys.argv[1:]; sys.argv = sys.argv[:1]  # the viewer takes its base from argv, else STEADING_BASE
v = SourceFileLoader("v", args[0]).load_module()
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
from importlib.machinery import SourceFileLoader
args = sys.argv[1:]; sys.argv = sys.argv[:1]
v = SourceFileLoader("v", args[0]).load_module()
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
  const run = (dir: string, main: string, cache: string) => {
    const code = `
import json, sys, time
from importlib.machinery import SourceFileLoader
v = SourceFileLoader("v", sys.argv[1]).load_module()
v.background = lambda fn, *a: fn(*a)
n = [0]; loads = json.loads
def counted(raw, *a, **k):
    n[0] += isinstance(raw, bytes)
    return loads(raw, *a, **k)
json.loads = counted
s = v.Agents(); s.session, s.looked = sys.argv[2], time.time()
s.read_main(); s.refresh()
sub = next(r for r in s.every if r.id == "aaa")
dump = lambda o: json.dumps(o.__dict__, sort_keys=True, default=lambda x: sorted(x) if isinstance(x, set) else str(type(x)))
print(json.dumps({"parsed": n[0], "read_to": s.read_to, "results": s.results, "notified": s.notified,
                  "main": dump(s.digest), "sub": dump(sub.digest), "calls": sub.calls}))
`;
    const r = Bun.spawnSync(["python3", "-I", "-c", code, join(root, "bin/viewer.py"), main], {
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
