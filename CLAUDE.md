# Steading

Agentic development environment on herdr: a deck pane beside the agent with
agents, jobs, servers, build, test, git and deploy sections (`bin/viewer.py`), fed by
Claude Code hooks (`bin/hook`, `bin/record`, `bin/open`) and herdr events (`bin/deck`).

## Rules

- **When the deck's UI changes, regenerate the README preview in the same change.**
  `docs/demo.svg` is an animated picture of the deck drawn by `docs/demo.py`, not a
  screenshot, so it goes stale silently. Any change to what a section shows or how
  (rows, the agents detail, colours, tabs, key hints, a new section) updates the
  matching scene in `docs/demo.py`, then:

  ```sh
  python3 docs/demo.py > docs/demo.svg
  ```

  Check it renders (`xmllint --noout docs/demo.svg`, and look at a scene) before committing.
- Run the tests (`bun test`) and read the whole summary, failures included, before committing.
  The full suite takes about 40 seconds: while working, run only the tests you touch
  (`bun test -t "<name>"`), and the full suite once, right before the commit.
- Editing `bin/viewer.py` restarts every open deck with the new code: a crash closes all of them.
