# The tabs

**English** · [한국어](tabs.ko.md) · [← README](../README.md)

Every tab works the same way: a list of runs, newest on top (the last 20, git the last 50), and the
picked run's output under it. The tab's name carries its latest status: `✓` `✗`, a spinner while
something runs, `●` for live servers. When something new comes in on another tab, that tab turns red until
you open it; the strip ends in a count of such tabs (`2 new`), and an arrow with one hidden behind it
turns red too. A click on the count or that arrow goes to the nearest one (the deck stays where you are), and the new row fades in from the tab's colour.

Runs are listed in words: what a test run tests ("Testing auth", "Running all the tests"), what a build
builds ("Building for release"), where a deploy goes ("Deploying to production"), and for jobs the agent's own
description or the command's main step ("Running s3.py", "Waiting 60s"). The command itself heads the run's box.

---

## agents

**Shows** the agent itself on top, then every Claude Code subagent at work (background and workflow
agents too; a subagent's own subagents sit indented under it), two rows each:

```
⠼ add refresh tokens to the auth middleware    opus-5-5
    Bash npm test                         ▰▰▰▱▱ 3/5  2m 16s
⠼ Map the auth tests                            haiku-5-5
    Read src/auth/refresh.test.ts                      40s
```

The first row is its name and model; the second, what it is doing now (a subagent: the call running, else its
latest words; the main agent: the task it has in hand, else what you last asked; or `waiting for you`), its tasks done when it keeps a list, and how long it has been at it. Pick one
for the whole picture, in cards (with **activity**: what it did in words, newest first: five, or all with "▾ more", which scrolls inside the card; a call that ran long has "↗ jobs #n" to its output): state, tokens per minute and a heartbeat of its activity, its full session title (a subagent: the task it was given), model and effort, context used, tokens, tools by
kind, and its task list, and a **team** card listing the subagents it started (at work or done, with model and time); in the list a subagent's own subagents hang off it on branch lines (├ └). Enter on a task shows the talk it came up in, in order.

**Comes in when** a session starts in the pane, and when the agent hands work to a subagent. Read
from the session's transcripts, as [zoetrope](https://github.com/furkankly/zoetrope) does.

## jobs

**Shows** the commands that take a while and are neither tests nor builds: a wait loop, an install, a
script given a long timeout. Each with what it is for (the call's description), how long it has run
against its timeout (`15s of 2m`), and its output as it comes. Once done it keeps its output and
exit code, a failure in red.

**Comes in when** any other command has run for 10 seconds (the jobs threshold: 5, 10 or 30 in the settings, `,`). Shorter ones never show. The output is
read from the file Claude Code writes the call's output to, so the call itself is never changed.

## servers

**Shows** the dev servers listening for this project, each with its port and log (the file it
writes to, or the herdr pane it prints in). The log follows the end; scroll and it holds still until
`esc`. `o` opens the server in the browser.

**Comes in when** a process inside the project, or started from any pane of its herdr workspace,
opens a port: `npm run dev`, `next dev`, `vite`, `anvil`, `uvicorn`, `flask run`, … The command is
left alone; the tab is marked new.

## build · test

**Shows** each run streamed live, in the colours you would see in a shell. Its box opens with a badge
(`✓ PASSED`, `✗ FAILED`, `⠼ RUNNING`) beside where it ran, how long it took and when; a test run's
passed and failed counts as a bar, read from the runner's summary; and down the log, line numbers
with a red bar on error lines and an amber one on warnings. Jobs and deploys look the same.

**Comes in when** the agent runs one:

- tests: `npm/pnpm/yarn test[:x]`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `bun test`,
  `deno test`, `forge test`, `make`/`just test`, `./test.sh`-style scripts
- builds: `npm/pnpm/yarn run build[:x]`, `tsc`, `next build`, `vite build`, `go build`,
  `cargo build`/`check`, `forge build`, `make`/`just build`, `./build.sh`-style scripts

A plain call (`[cd DIR &&] [VAR=val] [time|timeout N|env] [npx|pnpm|…] RUNNER [args]`, with at most
`2>&1` and one `| tail/head -n N`) runs inside the deck, and the agent still gets plain text and the
real exit code. Inside a chain or a pipe (`git status; npm test | grep FAIL`) it runs as written and
shows up once it has finished.

## git

**Shows** every command that changes the repository, one row per step
(`git add · git commit "Fix it" · git push`), with the branch it ran on and the commit it left; a
commit shows its whole message. The list's border shows the repository right now:

```
╭─ runs · 12 ─────────────── main ↑2 · 3 changed ─╮
```

the branch, commits not pushed (`↑`) or not pulled (`↓`), and files not committed (or `clean`).

**Comes in when** a command with `git` in it has run and changed something. `git status`, `git log`
and other reads stay out.

## deploy

**Shows** each deploy with its output and exit code.

**Comes in when** a real deploy has run: `vercel`, `railway up`, `netlify deploy`, `fly deploy`,
`wrangler deploy`, `firebase deploy`, `gcloud run deploy`, `terraform apply`, `kubectl apply`,
`helm upgrade`, `forge script --broadcast` and more ([full list](../bin/classify)). `vercel ls`,
`fly status` and other look-ups stay out.
