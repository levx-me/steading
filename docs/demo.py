#!/usr/bin/env python3
"""Draw the README demo, a Claude Code session beside the deck, as docs/demo.svg.

    python3 docs/demo.py > docs/demo.svg

The deck side cycles through its six sections in tab order, each a
layer of the SVG that CSS shows in turn; viewers who ask for reduced motion see
the first one still. Every run of text sits on a character grid at its own x,
so the columns line up whatever monospace font the viewer has. Colours are the
deck's own (bin/viewer.py).
"""
import random
import re
from xml.sax.saxutils import escape

CW, LH, FS = 8.4, 19, 14          # cell width, line height, font size (px)
PAD, TOP = 14, 38                 # inner padding, title bar height
A, D = 90, 60                     # agent and deck columns: 60:40
SB = 27                           # herdr's sidebar (spaces, agents) left of them, with a column's gap
SCENE_SECS = 3                    # how long each section shows
SPINNER = "·✢✳✶✻✽✻✶✳✢"            # Claude Code's spinner, forward and back
SPIN_SECS = 0.12                  # one spinner frame
TIMER_FROM = 12                   # the "Testing..." timer's first second
BRAILLE = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"            # the deck's spinner (bin/viewer.py), 8 frames a second
SPIN = "<spin>"                   # a run's text: the deck's spinner, turning
AGENTS_SECS = 5                   # the agents section stays longer: it moves the most
SCENE_TIMES = [AGENTS_SECS] + [SCENE_SECS] * 6  # in tab order
FADE_SECS = 2.5                   # a new run's row fades in from the section's colour (bin/viewer.py)
CYCLE = sum(SCENE_TIMES)          # one loop of the deck, in seconds: what ticks, ticks over it

BG, STRIP, TAB, ACTIVE = "#1b1e23", "#21252b", "#2c313a", "#3e4451"
MUTED, BRIGHT, TEXT, DIMMED = "#787f8c", "#dcdfe4", "#abb2bf", "#585e69"
GREEN, RED, AMBER, CYAN, BLUE = "#98b17d", "#d0868d", "#d8b46a", "#7fb4b4", "#7aa2c8"
ACCENT = {"AGENTS": "#8fa8d2", "JOBS": CYAN, "SERVERS": GREEN, "BUILD": AMBER, "TEST": BLUE, "GIT": "#b48ead", "DEPLOY": "#d19a66"}
CLAUDE = "#d77757"                # Claude Code's accent
RULE = "rule"


def tool(dot, name, arg):
    return [("● ", dot), (name, BRIGHT, True), (f"({arg})", TEXT)]


def result(*runs):
    return [("  └ ", MUTED), *runs]


def changed(added, removed):
    return result(("Updated with ", MUTED), (str(added), GREEN), (f" addition{'s' * (added != 1)} and ", MUTED),
                  (str(removed), RED), (f" removal{'s' * (removed != 1)}", MUTED))


# Agent pane: one list of (text, colour[, bold]) runs per row; RULE draws a line.
agent = [
    [],
    [("> ", MUTED), ("add refresh tokens to the auth middleware, with rotation and reuse detection", BRIGHT)],
    [],
    [("● ", BRIGHT), ("I'll add a refresh-token flow beside the access token, then build and test.", TEXT)],
    [],
    tool(GREEN, "Bash", "npm run dev"),
    result(("Running in the background: ", MUTED), ("http://localhost:3000", CYAN)),
    [],
    tool(GREEN, "Agent", "Map the auth tests"),
    result(("Running in the background", MUTED)),
    [],
    tool(GREEN, "Write", "src/auth/refresh.ts"),
    result(("Wrote 64 lines to src/auth/refresh.ts", MUTED)),
    [],
    tool(GREEN, "Update", "src/middleware/auth.ts"),
    changed(18, 4),
    [],
    tool(RED, "Bash", "npm test"),
    result(("Tests  ", TEXT), ("1 failed", RED), (" | ", MUTED), ("44 passed", GREEN), (" (45)", MUTED)),
    [("    +24 lines (ctrl+o to expand)", MUTED)],
    [],
    [("● ", BRIGHT), ("The expiry check rejects a token in its last second: ", TEXT), ("exp < now", CYAN),
     (" should be", TEXT)],
    [("  ", TEXT), ("exp <= now", CYAN), (". Fixing it and running the tests again.", TEXT)],
    [],
    tool(GREEN, "Update", "src/middleware/auth.ts"),
    changed(1, 1),
    [],
    tool(GREEN, "Bash", 'git commit -m "Refresh-token rotation"'),
    result(("[feat/refresh a41c9e2] Refresh-token rotation", MUTED)),
    [],
    tool(MUTED, "Bash", "npm test"),
    result(("Running...", MUTED)),
    [],
    "TESTING",  # the spinner and the timer: animated layers, drawn below
    [],
    RULE,
    [("> ", BRIGHT)],
    RULE,
    [("  ▸▸ ", CLAUDE), ("accept edits on", CLAUDE), (" (shift+tab to cycle)", MUTED)],
]
ROWS = len(agent)

SECTIONS = [("AGENTS", SPIN, AMBER), ("JOBS", SPIN, AMBER), ("SERVERS", "●", GREEN), ("BUILD", SPIN, AMBER), ("TEST", SPIN, AMBER),
            ("GIT", "✓", GREEN), ("DEPLOY", "·", MUTED)]

out = []


def x(col):
    return PAD + (col + SB) * CW  # column 0 is the agent pane's first; the sidebar sits at -SB..-2


def top(row):
    return TOP + PAD + (row + 1) * LH  # row -1: herdr's tab bar


def rect(col, row, cols, fill, rows=1, rx=0, stroke=None):
    paint = f'fill="none" stroke="{stroke}"' if stroke else f'fill="{fill}"'
    out.append(f'<rect x="{x(col):.1f}" y="{top(row):.1f}" width="{cols * CW:.1f}" height="{rows * LH:.1f}" '
               f'rx="{rx}" {paint}/>')


def line(col0, row0, col1, row1, colour):
    out.append(f'<line x1="{x(col0):.1f}" y1="{top(row0):.1f}" x2="{x(col1):.1f}" y2="{top(row1):.1f}" '
               f'stroke="{colour}" stroke-width="1"/>')


def text(col, row, runs, limit):
    """Runs of text on the grid. A run whose text is SPIN turns as the deck's spinner;
    one whose text is a function of the second (0..CYCLE-1) ticks with the loop."""
    for run in runs:
        if run[0] == SPIN:
            for j, frame in enumerate(BRAILLE):
                layer("b", j, lambda: text(col, row, [(frame, *run[1:])], limit))
            col += 1
            continue
        if callable(run[0]):
            width = max(len(run[0](i)) for i in range(CYCLE))
            for i in range(CYCLE):
                layer("t", i, lambda: text(col, row, [(run[0](i).ljust(width), *run[1:])], limit))
            col += width
            continue
        s, colour, bold = run[0], run[1], len(run) > 2 and run[2] is not False
        if len(run) > 4 and run[4]:  # a background behind the run (a badge)
            rect(col, row, len(s), run[4])
        underline = ' text-decoration="underline"' if len(run) > 3 and run[3] == "u" else ""
        lead, body = len(s) - len(s.lstrip(" ")), s.strip(" ")
        assert col + len(s) <= limit, f"row {row} runs past column {limit}: {s!r}"
        if body:
            # textLength pins the run to its cells, so a wider font cannot push it out of line.
            weight = ' font-weight="bold"' if bold else ""
            out.append(f'<text x="{x(col + lead):.1f}" y="{top(row) + LH * 0.72:.1f}" '
                       f'textLength="{len(body) * CW:.1f}" lengthAdjust="spacingAndGlyphs" '
                       f'fill="{colour}"{weight}{underline}>{escape(body)}</text>')
        col += len(s)


W = x(A + 1 + D) + PAD
H = TOP + PAD * 2 + (ROWS + 1) * LH
d0, end = A + 1, A + 1 + D

# Window, title bar, pane divider.
out.append(f'<rect width="{W:.0f}" height="{H:.0f}" rx="10" fill="{BG}"/>')
out.append(f'<path d="M10 0H{W - 10:.0f}a10 10 0 0 1 10 10V{TOP}H0V10a10 10 0 0 1 10-10z" fill="{STRIP}"/>')
for i, c in enumerate(("#ff5f57", "#febc2e", "#28c840")):
    out.append(f'<circle cx="{20 + i * 20}" cy="{TOP / 2}" r="6" fill="{c}"/>')
out.append(f'<text x="{W / 2:.0f}" y="{TOP / 2 + 5}" fill="{MUTED}" text-anchor="middle">herdr</text>')
# herdr around the panes (no pane borders, as configured): its tab bar over them, and the
# sidebar of spaces and agents on the left. Example workspaces, not real ones.
side = -SB
text(side, -1, [("spaces", MUTED)], -1)
spaces = [("◐", AMBER, "app", "feat/refresh", True), ("○", MUTED, "api", "main", False),
          ("○", MUTED, "web", "dev", False), ("○", MUTED, "docs", "main", False)]
for i, (icon, colour, name, branch, on) in enumerate(spaces):
    if on:
        rect(side, 1 + 2 * i, SB - 1, ACTIVE, rows=2)
    text(side, 1 + 2 * i, [(icon + " ", colour), (name, BRIGHT if on else TEXT)], -1)
    text(side, 2 + 2 * i, [("└", BRIGHT), (" · " + branch, BLUE)], -1)
text(side, 12, [("new", DIMMED), ("● ".rjust(SB - 8), BLUE), ("menu", DIMMED)], -1)
line(side, 13.5, -1, 13.5, ACTIVE)
text(side, 14, [("agents", MUTED), ("priority".rjust(SB - 7), MUTED)], -1)
# Agent rows as Steading lays them out: each agent's repository ($repo) and model and
# context use ($ctx, or $ctxhot in red from 80%) and tasks ($tasks), reported by its hook (bin/sidebar).
crew = [("app", "feature", "◐", AMBER, "feat/auth · 3 changed", "opus-5-5", "▰▰▱▱▱ 34%", False, "▰▰▰▱▱ 3/5", True),
        ("api", "main", "○", GREEN, "main ↑2 · clean", "sonnet-5-5", "▰▰▰▱▱ 58%", False, "", False),
        ("web", "dev", "!", RED, "dev ↓1 · 1 changed", "opus-5-5", "▰▰▰▰▱ 86%", True, "▰▱▱▱▱ 1/4", False),
        ("docs", "main", "○", GREEN, "main · clean", "haiku-5-5", "▰▱▱▱▱ 12%", False, "", False)]
row = 16
for name, tab, icon, colour, repo, model, ctx, hot, tasks, on in crew:
    # Tree guides are tokens of their own in white ($tree1..3), herdr joins tokens with " · ".
    def guide(last):
        return [("└" if last else "├", BRIGHT), (" · ", MUTED)]
    lines = [[(icon + " ", colour), (name, BRIGHT, True), (" · " + tab, MUTED)], guide(False) + [(repo.partition(" · ")[0], BLUE), (" · " + repo.partition(" · ")[2], MUTED)],
             guide(not tasks) + [(model + " · ", MUTED), (ctx, RED, True) if hot else (ctx, MUTED)]]
    lines += [guide(True) + [(tasks, MUTED)]] if tasks else []
    if on:
        rect(side, row, SB - 1, ACTIVE, rows=len(lines))
    for n, spans in enumerate(lines):
        text(side, row + n, spans, -1)
    row += len(lines)
text(-3, ROWS - 1, [("«", MUTED)], -1)
# The tab bar: this space's tabs, then the usage figures herdr's tab_bar_right shows.
rect(0, -1, A + 1 + D, STRIP)
tabs = [("1 · feature", True), ("2 · nvim", False), ("3 · server", False)]
col = 0
for name, on in tabs:
    if on:
        rect(col, -1, len(name) + 4, BLUE)
    text(col, -1, [(f"  {name}  ", STRIP if on else MUTED, on)], A + 1 + D)
    col += len(name) + 5
text(col, -1, [("+", MUTED)], A + 1 + D)
text(A + 1 + D - 24, -1, [("claude ", MUTED), ("24%/40%", TEXT), (" │ @19:51", MUTED)], A + 1 + D)

css = []


def layers(prefix, n, secs, slots=None):
    """CSS showing layers {prefix}0..{prefix}{n-1} one at a time over a secs-long
    loop, each for its slot (equal, or the given lengths), switching at once (step-end)."""
    slots = slots or [secs / n] * n
    edges = [sum(slots[:i]) * 100 / sum(slots) for i in range(n + 1)]
    css.append(f".{prefix}{{opacity:0;animation-duration:{secs}s;animation-iteration-count:infinite;"
               "animation-timing-function:step-end}" f".{prefix}0{{opacity:1}}")
    for i in range(n):
        a, b = edges[i], edges[i + 1]
        frames = f"0%{{opacity:{1 if i == 0 else 0}}}" + (f"{a:.3f}%{{opacity:1}}" if i else "")
        frames += f"{b:.3f}%{{opacity:0}}100%{{opacity:0}}"
        css.append(f"@keyframes {prefix}k{i}{{{frames}}}.{prefix}{i}{{animation-name:{prefix}k{i}}}")


def layer(prefix, i, draw):
    out.append(f'<g class="{prefix} {prefix}{i}">')
    draw()
    out.append("</g>")


# Agent pane. "Testing..." spins and counts up as Claude Code's does.
for row, runs_ in enumerate(agent):
    if runs_ == RULE:
        line(0, row + 0.5, A, row + 0.5, MUTED)
    elif runs_ == "TESTING":
        for i, glyph in enumerate(SPINNER):
            layer("p", i, lambda: text(1, row, [(glyph, CLAUDE)], A))
        text(3, row, [("Testing...", CLAUDE), (" (", MUTED)], A)
        text(15, row, [(lambda i: f"{TIMER_FROM + i}s", MUTED), (" · esc to interrupt)", MUTED)], A)
    else:
        text(1, row, runs_, A)


# The deck's pieces --------------------------------------------------------------

def section_bar(active):
    """The tabs, scrolled as bin/viewer.py's strip() does so the active one shows."""
    rect(d0, 0, D, STRIP)
    widths = [len(name) + 4 for name, _, _ in SECTIONS]
    count = " 1 new " if active < 3 else ""  # the build tab, new until shown (bin/viewer.py strip)
    close = 3  # " ✕ " first: a click closes the deck (bin/viewer.py CLOSE_W)
    room = D - close - 2 - (len(count) + 1 if count else 0)
    first = 0
    while first < active and sum(w + 1 for w in widths[first:active + 1]) > room:
        first += 1
    col, used = d0 + close + 1, 0
    text(d0, 0, [(" ✕ ", RED, True)], end)
    text(d0 + close, 0, [("‹" if first else " ", MUTED)], end)
    shown_last = first
    for i in range(first, len(SECTIONS)):
        name, icon, colour = SECTIONS[i]
        new = name == "BUILD" and active < i  # a build came in while you were elsewhere: new until shown
        if used + widths[i] + 1 > room:
            break
        on = i == active
        rect(col, 0, widths[i], ACCENT[name] if on else "#976870" if new else TAB)  # bin/viewer.py NEW_RGB
        ink = STRIP if on else BRIGHT if new else MUTED
        # The first letter underlined: shift and that letter goes to the tab (bin/viewer.py TAB_KEYS).
        at = 1 if name == "GIT" else 0  # git's key is I (bin/viewer.py TAB_KEYS)
        text(col, 0, [(" " + name[:at], ink, on or new), (name[at], ink, on or new, "u"), (f"{name[at + 1:]} ", ink, on or new),
                      (icon, STRIP if on else BRIGHT if new else colour, on or new)], end)
        col += widths[i] + 1
        used += widths[i] + 1
        shown_last = i
    if shown_last < len(SECTIONS) - 1:
        text(col, 0, [("›", MUTED)], end)
    if count:
        rect(d0 + D - len(count), 0, len(count), "#976870")
        text(d0 + D - len(count), 0, [(count, BRIGHT, True)], end)


def run_box(rows, accent, noun, picked=0, fade=None, state=None):
    """The run list: a rounded box, its count in the border, run `picked` raised.
    A row with no icon continues the run above (a git run's steps). `state` runs
    to the right end of the top border (git: the repository's state)."""
    first = 2
    rect(d0 + 0.5, first - 0.5, D - 1, None, rows=len(rows) + 1, rx=5, stroke=accent)
    title = f" {noun} · {sum(1 for r in rows if r[0])} "
    out.append(f'<rect x="{x(d0 + 1.5):.1f}" y="{top(first - 1) + LH * 0.1:.1f}" width="{len(title) * CW:.1f}" '
               f'height="{LH * 0.8:.1f}" fill="{BG}"/>')
    text(d0 + 2, first - 1, [(title, MUTED)], end)
    if state:
        width = sum(len(t) for t, _ in state)
        out.append(f'<rect x="{x(d0 + D - 2 - width):.1f}" y="{top(first - 1) + LH * 0.1:.1f}" '
                   f'width="{width * CW:.1f}" height="{LH * 0.8:.1f}" fill="{BG}"/>')
        text(d0 + D - 2 - width, first - 1, state, end)
    starts = [n for n, r in enumerate(rows) if r[0]]
    at = starts[picked]
    span = (starts[picked + 1] if picked + 1 < len(starts) else len(rows)) - at
    rect(d0 + 1, first + at, D - 2, ACTIVE, rows=span)
    if fade:  # a run just added: its row starts in the section's colour and fades (bin/viewer.py FADE_SECS)
        out.append(f'<rect class="{fade}" x="{x(d0 + 1):.1f}" y="{top(first + at):.1f}" width="{(D - 2) * CW:.1f}" '
                   f'height="{span * LH:.1f}" fill="{accent}"/>')
    for i, (icon, colour, label, right) in enumerate(rows):
        on = at <= i < at + span
        sub = not icon and right  # an agent's second row: what it does, then (text, colour) runs
        mark = [(SPIN, colour), (" ", colour)] if icon == SPIN else [(f"{icon} " if icon else "  ", colour)]
        if isinstance(label, tuple):  # an agent's first row: its name, then what it does now
            name, doing = label
            body = [(name, BRIGHT if on else TEXT, on), (doing, ACCENT["AGENTS"])]  # the doing text in the section's colour, as in the deck
        else:
            body = [(label, MUTED) if sub else (label, BRIGHT if on else TEXT, on)]
        left = [("   ", MUTED), *mark, *body]
        room = D - 2 - (3 + 2 + sum(len(t) for t, *_ in body)) - 1
        if isinstance(right, list):
            width = sum(max(len(t(n)) for n in range(CYCLE)) if callable(t) else len(t) for t, _ in right)
            text(d0, first + i, left + [(" " * (room - width), MUTED), *right], end)
            continue
        tail = (lambda n: lambda t: right(t).rjust(n))(room) if callable(right) else right.rjust(room)
        text(d0, first + i, left + [(tail, MUTED)], end)
    return first + len(rows) + 1


def browse(section, rows, accent, noun, contents, keys, state=None):
    """A run section whose selection walks down a run a second through its slot of
    the loop, the head and output below following it."""
    section_bar(section)
    start = sum(SCENE_TIMES[:section])
    # The newest run has just come in as the section opens: its row fades in, as the deck's does.
    a, b = 100 * start / CYCLE, 100 * (start + FADE_SECS) / CYCLE
    css.append(f".f{section}{{animation:fk{section} {CYCLE}s linear infinite;opacity:0}}"
               f"@keyframes fk{section}{{0%,{a:.3f}%{{opacity:0}}{a + 0.001:.3f}%{{opacity:.9}}"
               f"{b:.3f}%,100%{{opacity:0}}}}")
    if SECTIONS[section][0] in ("JOBS", "BUILD", "TEST", "DEPLOY"):  # bin/viewer.py REPORTED
        contents = [reported(SECTIONS[section][0], c) for c in contents]
    for picked, content in enumerate(contents):
        fade = f"f{section}" if picked == 0 else None
        layer("t", start + picked, lambda: body(run_box(rows, accent, noun, picked, fade, state), content))
    hints(keys)


def plain(runs):
    return "".join(r[0](0) if callable(r[0]) else ("⠋" if r[0] == SPIN else r[0]) for r in runs)


def reported(kind, content):
    """A run's box as bin/viewer.py draws a reported one: a status badge with where and how
    long on the right, the command, a test run's summary bar, then the log with a gutter
    of line numbers, red or amber on error and warning lines."""
    command, info, rest = content[0], content[1], content[3:]
    said = plain(info)
    if "running" in said:
        word, rgb, icon = "RUNNING", AMBER, SPIN
    elif "exit 1" in said:
        word, rgb, icon = "FAILED", RED, "✗"
    else:
        word, rgb, icon = {"TEST": "PASSED", "BUILD": "BUILT", "DEPLOY": "DEPLOYED"}.get(kind, "DONE"), GREEN, "✓"
    meta = [(r[0].lstrip() if i == 0 and not callable(r[0]) else r[0], MUTED) for i, r in enumerate(info)
            if callable(r[0]) or r[0].strip() not in ("exit 0", "exit 1")]
    meta = [(t.replace(" · exit 0", "").rstrip(" ·") if isinstance(t, str) else t, c) for t, c in meta]
    badge = [(" ", STRIP, True, None, rgb), (icon, STRIP, True, None, rgb), (f" {word} ", STRIP, True, None, rgb)]
    width = len(word) + 4 + sum(max(len(t(n)) for n in range(CYCLE)) if callable(t) else len(t) for t, _ in meta)
    head = [badge + [(" " * (D - 4 - width), MUTED)] + meta, command]
    text_ = " ".join(plain(r) for r in rest if r != RULE)
    passed = re.findall(r"(\d+) passed", text_)  # the last: the runner's closing summary
    failed = re.findall(r"(\d+) failed", text_)
    if kind == "TEST" and passed:
        p, f = int(passed[-1]), int(failed[-1]) if failed else 0
        cells = 20
        green = round(cells * p / (p + f))
        head.append([("█" * green, GREEN), ("█" * (cells - green), RED), (f"  {p} passed", GREEN)]
                    + ([(" · ", MUTED), (f"{f} failed", RED)] if f else []) + [(f" · {p + f} total", MUTED)])
    log = []
    for n, r in enumerate(rest, 1):
        said = plain(r)
        mark = RED if re.search(r"\w*error\b|\bfail(ed)?\b|✗", said, re.I) and not re.search(r"\b0 fail", said) \
            else AMBER if re.search(r"\bwarn", said, re.I) else None
        log.append([(f"{n:>2}", DIMMED), ("▌" if mark else "│", mark or "#464c58"), (" ", MUTED), *r])
    return head + [RULE] + log


def hints(pairs):
    rect(d0, ROWS - 1, D, STRIP)
    text(d0, ROWS - 1, [r for k, what in pairs for r in ((f" {k}", BRIGHT), (f" {what} ", MUTED))], end)


def body(row, lines):
    """The run's box under the list, down to the hints (bin/viewer.py Runs.frame): grey, as
    the cursor is in the list; the lines inside it."""
    edge, last = "#464c58", ROWS - 2
    text(d0, row, [("╭" + "─" * (D - 2) + "╮", edge)], end)
    for r in range(row + 1, last):
        text(d0, r, [("│", edge)], end)
        text(end - 1, r, [("│", edge)], end)
    text(d0, last, [("╰" + "─" * (D - 2) + "╯", edge)], end)
    for i, runs_ in enumerate(lines[:last - row - 1]):
        if runs_ == RULE:
            line(d0 + 2, row + 1 + i + 0.5, end - 2, row + 1 + i + 0.5, ACTIVE)
        else:
            text(d0 + 2, row + 1 + i, runs_, end - 2)


def heartbeat(n, seed=7):
    """n columns of a working agent's heartbeat: bursts of writes of uneven height
    (a reply, a run of tool calls) with quiet gaps between, and the tok/min each
    second would read (the last minute's columns, scaled). Seeded: the file stays put."""
    rng = random.Random(seed)
    counts = []
    while len(counts) < n:
        if rng.random() < 0.35:                      # a quiet stretch: waiting on a tool
            counts += [0] * rng.randint(1, 5)
        else:                                        # a burst: rises, peaks, falls off unevenly
            peak = rng.randint(2, 9)
            counts += [max(1, int(peak * rng.uniform(0.3, 1.0))) for _ in range(rng.randint(2, 7))]
    counts = counts[:n]
    top = max(counts)
    beats = "".join(" ▁▂▃▄▅▆▇█"[min(8, -(-c * 8 // top))] if c else " " for c in counts)
    rates = []
    for t in range(n - (D - 2) + 1):
        window = counts[t + D - 2 - 6:t + D - 2]  # the newest 6 columns: the last minute
        rates.append(f"{sum(window) * 0.21:.1f}k" if sum(window) else "0")
    return beats, rates


def took(secs):
    return f"{secs // 60}m {secs % 60}s" if secs >= 60 else f"{secs}s"


def label(name, *runs):
    return [(f"{name:<10} ", MUTED), *runs]


def card(title, rows):
    """Rows in a rounded box the deck's width, its title in the top border (bin/viewer.py card)."""
    inner, edge = D - 8, "#464c58"  # inside the run's box
    width = lambda runs: sum(1 if t == SPIN else max(len(t(n)) for n in range(CYCLE)) if callable(t) else len(t)
                             for t, *_ in runs)
    top = [("╭─", edge), (f" {title} ", MUTED), ("─" * (inner - len(title) - 2) + "─╮", edge)]
    return [top] + [[("│ ", edge), *r, (" " * (inner - width(r)) + " │", edge)] for r in rows] + \
        [[("╰" + "─" * (inner + 2) + "╯", edge)]]


def bar(parts, width):
    """A stacked bar as runs: [(cells, colour)], the rest of width in track grey."""
    runs = [("█" * n, c) for n, c in parts if n]
    used = sum(n for n, _ in parts)
    return runs + ([("░" * (width - used), TAB)] if width > used else [])


# The scenes ------------------------------------------------------------------

def scene_agents():
    section_bar(0)
    # The heartbeat scrolls left a column a second, new beats coming in at the right.
    beats, rates = heartbeat(CYCLE + D - 2)
    # Name column, then what it does now, its model (and effort) at the right; the work it was given
    # on the row below (bin/viewer.py AgentRun).
    pad = lambda tree, name: f"{tree}{name}".ljust(21)
    row = run_box([(SPIN, AMBER, (pad("", "main"), "  ◐ Fix expiry"), [("opus-5-5 · high", BRIGHT)]),
                   ("", AMBER, "  auth refresh tokens", [("▰▰▰", GREEN), ("▱▱", DIMMED), (" 3/5  ", MUTED),
                                                    (lambda t: took(134 + t).rjust(6), MUTED)]),
                   # A manager and its workers, on branch lines.
                   (SPIN, AMBER, (pad("  └ ", "foreman"), "  Splitting work"), [("sonnet-5-5", BRIGHT)]),
                   ("", AMBER, "      Map the auth tests", [(lambda t: took(38 + t).rjust(6), MUTED)]),
                   (SPIN, AMBER, (pad("    ├ ", "foreman-scout"), "  Searching"), [("haiku-5-5", BRIGHT)]),
                   ("", AMBER, "        Find every refresh call", [(lambda t: took(21 + t).rjust(6), MUTED)]),
                   (SPIN, AMBER, (pad("    └ ", "foreman-builder"), "  Writing tests"), [("sonnet-5-5", BRIGHT)]),
                   ("", AMBER, "        Write the rotation tests", [(lambda t: took(17 + t).rjust(6), MUTED)])],
                  ACCENT["AGENTS"], "agents")
    rect(d0 + 3, row + 1, 11, AMBER)  # the WORKING pill, inside the run's box
    body(row, [
        [("  ", STRIP, True), (SPIN, STRIP, True), (" WORKING ", STRIP, True), ("   ", MUTED), ("↑", GREEN),
         (lambda t: f" {rates[t % len(rates)]} tok/min", MUTED)],
        [],
        [(" ", AMBER), (lambda t: beats[t:t + D - 6], AMBER)],
        [(" 8m ago", MUTED), ("now".rjust(D - 13), MUTED)],
        [],
        *card("model", [
            [(" opus-5-5 ", BRIGHT), ("  ", MUTED), (" medium ", AMBER), ("  ✻ thought 1.3s", MUTED)],
            [("context ", MUTED), *bar([(8, GREEN)], 24), (" 34%", GREEN), (" 68k/200k", MUTED)],
            [("tokens  ", MUTED), ("in ", MUTED), ("2k  ", TEXT), ("cache ", MUTED), ("1.4M  ", TEXT),
             ("out ", MUTED), ("18k", TEXT)],
            [("tools   ", MUTED), *bar([(9, GREEN), (6, BLUE), (5, AMBER), (2, CYAN)], 22)],
            [("        ", MUTED), ("■ ", GREEN), ("run 9  ", MUTED), ("■ ", BLUE), ("read 6  ", MUTED),
             ("■ ", AMBER), ("edit 5  ", MUTED), ("■ ", CYAN), ("search 2", MUTED)]]),
        *card("subagents 1/1 at work", [[(SPIN, AMBER), (" foreman", TEXT), (lambda t: f"sonnet-5-5  {took(38 + t):>6}".rjust(D - 8 - 20), MUTED)]]),
        *card("session", [[("add refresh tokens to the auth middleware", BRIGHT, True)]]),
        *card("activity", [
            [(SPIN, AMBER), (" Run the auth tests", BRIGHT), (lambda t: f"{12 + t}s".rjust(D - 8 - 20), MUTED)],
            [("✓ ", GREEN), ("Wait for the API to answer", MUTED), (" " * (D - 8 - 2 - 26 - 11), MUTED),
             (" ↗ jobs #3 ", ACCENT["JOBS"], False, None, TAB)],
            [("✓ ", GREEN), ("Editing src/middleware/auth.ts", MUTED)],
            [("✓ ", GREEN), ("Reading src/auth/refresh.ts", MUTED)],
            [(" ▾ 18 more ", ACCENT["AGENTS"], False, None, TAB)]]),
        *card("tasks 3/5", [  # what is left first, then the done ones, newest first (bin/viewer.py Digest.listed)
            [("◐ ", AMBER), ("Fix the last-second expiry", TEXT)],
            [("○ ", MUTED), ("Document the flow", TEXT)],
            [("✓ ", GREEN), ("Detect a reused token", TEXT)],
            [("✓ ", GREEN), ("Rotate on every refresh", TEXT)],
            [("✓ ", GREEN), ("Add the refresh-token store", TEXT)]]),
    ])
    hints([("L", "side"), ("[ ]", "sections"), (",", "settings"), ("ctrl+c", "close")])


RUN_KEYS = [("L", "side"), ("[ ]", "sections"), (",", "settings"), ("ctrl+c", "close")]


def scene_jobs():
    browse(1, [(SPIN, AMBER, "Wait for the API to answer", lambda t: f"running {t + 9}s"),
               ("✓", GREEN, "Install Playwright's Chromium", "1m 12s · 4m ago"),
               ("✓", GREEN, "Seed the dev database", "48s · 26m ago")], ACCENT["JOBS"], "jobs", [
        [[("$ ", MUTED), ("until curl -sf localhost:3000/health; do sleep 2; done", BRIGHT, True)],
         [(lambda t: f"  ~/app · {t + 9}s of 2m · running", MUTED)], RULE,
         [("curl: (7) Failed to connect to localhost port 3000", MUTED)],
         [("curl: (7) Failed to connect to localhost port 3000", MUTED)],
         [("curl: (7) Failed to connect to localhost port 3000", MUTED)]],
        [[("$ ", MUTED), ("npx playwright install chromium", BRIGHT, True)],
         [("  ~/app · ran 1m 12s · exit 0", MUTED)], RULE,
         [("Downloading Chromium 131.0.6778.33", TEXT)],
         [("|████████████████████| 100% of 162.8 MiB", GREEN)],
         [("Chromium downloaded to ~/Library/Caches", TEXT)]],
        [[("$ ", MUTED), ("npm run db:reset && npm run db:seed", BRIGHT, True)],
         [("  ~/app · ran 48s · exit 0", MUTED)], RULE,
         [("Applied 14 migrations", TEXT)],
         [("Seeded 2,400 users, 18,250 sessions", GREEN)]],
    ], RUN_KEYS)


def scene_servers():
    log = lambda *lines: [*lines]
    browse(2, [("●", GREEN, "next dev --turbopack", ":3000"), ("●", GREEN, "anvil --block-time 2", ":8545"),
               ("●", GREEN, "wrangler dev", ":8787")], ACCENT["SERVERS"], "servers", [
        log([("$ ", MUTED), ("next dev --turbopack", BRIGHT, True)],
            [("  ", MUTED), ("http://localhost:3000", CYAN), (" · pid 41233 · log file", MUTED)], RULE,
            [("   ▲ Next.js 15.4.1 (Turbopack)", TEXT)],
            [("   - Local:        ", MUTED), ("http://localhost:3000", CYAN)], [],
            [(" ✓ ", GREEN), ("Ready in 812ms", TEXT)],
            [(" ✓ ", GREEN), ("Compiled /api/auth/refresh in 214ms", TEXT)],
            [(" POST ", TEXT), ("/api/auth/refresh ", TEXT), ("200", GREEN), (" in 38ms", MUTED)],
            [(" POST ", TEXT), ("/api/auth/refresh ", TEXT), ("401", RED), (" in 12ms", MUTED)]),
        log([("$ ", MUTED), ("anvil --block-time 2", BRIGHT, True)],
            [("  ", MUTED), ("http://localhost:8545", CYAN), (" · pid 41250 · pane w1:p4", MUTED)], RULE,
            [("Listening on 127.0.0.1:8545", TEXT)], [],
            [("    Block Number: ", MUTED), ("1842", TEXT)],
            [("    Block Hash: ", MUTED), ("0x9c1f…a07e", TEXT)],
            [("    eth_sendRawTransaction", CYAN)],
            [("    Transaction: ", MUTED), ("0x4b2d…91c3", TEXT)],
            [("    Gas used: ", MUTED), ("46109", TEXT)]),
        log([("$ ", MUTED), ("wrangler dev", BRIGHT, True)],
            [("  ", MUTED), ("http://localhost:8787", CYAN), (" · pid 41302 · log file", MUTED)], RULE,
            [(" wrangler 4.20.0", TEXT)],
            [("Your Worker has access to the following bindings:", MUTED)],
            [("- KV Namespaces: SESSIONS", TEXT)], [],
            [("[wrangler:info] Ready on ", TEXT), ("http://localhost:8787", CYAN)],
            [("[wrangler:info] GET /health ", TEXT), ("200", GREEN), (" OK (3ms)", MUTED)]),
    ], [("o", "browser"), ("L", "side"), ("[ ]", "tabs"), (",", "settings"), ("ctrl+c", "close")])


def scene_build():
    browse(3, [(SPIN, AMBER, "Building the project", "now"), ("✓", GREEN, "Building the project", "6m ago"),
               ("✗", RED, "Building the project", "21m ago")], ACCENT["BUILD"], "runs", [
        [[("$ ", MUTED), ("npm run build", BRIGHT, True)],
         [("  ~/app · ", MUTED), (lambda t: f"{9 + t}s", MUTED), (" · running", MUTED)], RULE,
         [("> next build", MUTED)], [], [("   ▲ Next.js 15.4.1", TEXT)], [],
         [("   Creating an optimized production build ...", TEXT)],
         [(" ✓ ", GREEN), ("Compiled successfully in 6.2s", TEXT)],
         [(" ✓ ", GREEN), ("Linting and checking validity of types", TEXT)],
         [("   Collecting page data ", TEXT), ("...", MUTED)], [],
         [(SPIN, AMBER), (" running ", AMBER), (lambda t: f"{9 + t}s", AMBER)]],
        [[("$ ", MUTED), ("npm run build", BRIGHT, True)],
         [("  ~/app · 14s · exit 0", MUTED)], RULE,
         [("> next build", MUTED)], [],
         [(" ✓ ", GREEN), ("Compiled successfully in 5.8s", TEXT)],
         [(" ✓ ", GREEN), ("Generating static pages (12/12)", TEXT)], [],
         [("Route (app)            Size  First Load JS", MUTED)],
         [("┌ ○ /                  5.2 kB       108 kB", TEXT)],
         [("└ ƒ /api/auth/refresh    0 B            0 B", TEXT)]],
        [[("$ ", MUTED), ("npm run build", BRIGHT, True)],
         [("  ~/app · 7s · ", MUTED), ("exit 1", RED)], RULE,
         [("> next build", MUTED)], [],
         [("Failed to compile.", RED)], [],
         [("./src/auth/refresh.ts:41:7", CYAN)],
         [("Type error: Property 'family' does not exist", TEXT)],
         [("on type 'TokenRecord'.", TEXT)], [],
         [("  40 |   const record = await store.get(id)", MUTED)],
         [("> 41 |   if (record.family !== family) {", TEXT)],
         [("     |       ", MUTED), ("^", RED)]],
    ], RUN_KEYS)


def scene_test():
    browse(4, [(SPIN, AMBER, "Running all the tests", "now"), ("✗", RED, "Running all the tests", "1m ago"),
               ("✓", GREEN, "Testing auth", "9m ago"), ("✓", GREEN, "Running all the tests", "24m ago"),
               ("✓", GREEN, "Running all the tests", "1h ago")], ACCENT["TEST"], "runs", [
        [[("$ ", MUTED), ("npm test", BRIGHT, True)],
         [("  ~/app · ", MUTED), (lambda t: f"{12 + t}s", MUTED), (" · running", MUTED)], RULE,
         [(" RUN ", BLUE, True), (" v3.2.4 ", TEXT), ("~/app", MUTED)], [],
         [(" ✓ ", GREEN), ("src/routes/users.test.ts ", TEXT), ("(9 tests) 120ms", MUTED)],
         [(" ✓ ", GREEN), ("src/session.test.ts ", TEXT), ("(5 tests) 41ms", MUTED)],
         [(" ✓ ", GREEN), ("src/auth/refresh.test.ts ", TEXT), ("(6 tests) 33ms", MUTED)],
         [(" > ", AMBER), ("src/middleware/auth.test.ts ", TEXT), ("(7 tests) 4/7", MUTED)],
         [("   ✓ ", GREEN), ("rotates the refresh token on every use", TEXT)],
         [("   ✓ ", GREEN), ("accepts a token in its last second", TEXT)], [],
         [(SPIN, AMBER), (" running ", AMBER), (lambda t: f"{12 + t}s", AMBER)]],
        [[("$ ", MUTED), ("npm test", BRIGHT, True)],
         [("  ~/app · 11s · ", MUTED), ("exit 1", RED)], RULE,
         [(" ✗ ", RED), ("src/middleware/auth.test.ts ", TEXT), ("(7 tests | 1 failed)", MUTED)],
         [("   ✗ ", RED), ("accepts a token in its last second", TEXT)], [],
         [(" FAIL ", RED, True), (" src/middleware/auth.test.ts", TEXT)],
         [("AssertionError: expected 401 to be 200", TEXT)], [],
         [("- Expected  ", GREEN), ("+ Received", RED)],
         [("- 200", GREEN)], [("+ 401", RED)], [],
         [(" Tests  ", TEXT), ("1 failed", RED), (" | ", MUTED), ("44 passed", GREEN), (" (45)", MUTED)]],
        [[("$ ", MUTED), ("npm test -- auth", BRIGHT, True)],
         [("  ~/app · 3s · exit 0", MUTED)], RULE,
         [(" ✓ ", GREEN), ("src/auth/refresh.test.ts ", TEXT), ("(6 tests) 33ms", MUTED)],
         [(" ✓ ", GREEN), ("src/middleware/auth.test.ts ", TEXT), ("(6 tests) 52ms", MUTED)], [],
         [(" Test Files  ", TEXT), ("2 passed", GREEN), (" (2)", MUTED)],
         [("      Tests  ", TEXT), ("12 passed", GREEN), (" (12)", MUTED)],
         [("   Duration  ", TEXT), ("1.94s", MUTED)]],
    ], RUN_KEYS)


def scene_git():
    bar_ = ("  │ ", ACCENT["GIT"])
    browse(5, [("✓", GREEN, "git add", "feat/refresh  1m ago  a41c9e2"),
               ("", MUTED, 'git commit "Refresh-token rotation"', ""),
               ("✓", GREEN, "git push", "feat/refresh  9m ago  7d03b18"),
               ("✓", GREEN, "git switch -c feat/refresh", "feat/refresh  14m ago"),
               ("✓", GREEN, "git pull", "main  32m ago  51e2a90")], ACCENT["GIT"], "runs", [
        [[("$ git add", BRIGHT, True)], [("$ git commit", BRIGHT, True)],
         [bar_, ("Refresh-token rotation", TEXT)], [bar_],
         [bar_, ("Each refresh issues a new token and retires the old", TEXT)],
         [bar_, ("one; a retired token coming back revokes the family.", TEXT)],
         [("  ~/app · on feat/refresh · 1s · exit 0", MUTED)],
         [("  commit ", MUTED), ("a41c9e2b7f0d5c18e9a3", ACCENT["GIT"])], RULE,
         [("[feat/refresh a41c9e2] Refresh-token rotation", TEXT)],
         [(" 3 files changed, ", TEXT), ("82 insertions(+)", GREEN), (", ", TEXT), ("5 deletions(-)", RED)]],
        [[("$ git push", BRIGHT, True)],
         [("  ~/app · on feat/refresh · 2s · exit 0", MUTED)],
         [("  commit ", MUTED), ("7d03b18e4c2a9f1065bd", ACCENT["GIT"])], RULE,
         [("To github.com:acme/app.git", TEXT)],
         [(" * [new branch]      feat/refresh -> feat/refresh", GREEN)],
         [("branch 'feat/refresh' set up to track", MUTED)],
         [("'origin/feat/refresh'.", MUTED)]],
        [[("$ git switch -c feat/refresh", BRIGHT, True)],
         [("  ~/app · on feat/refresh · 0s · exit 0", MUTED)], RULE,
         [("Switched to a new branch 'feat/refresh'", TEXT)]],
    ], RUN_KEYS, state=[(" feat/refresh", ACCENT["GIT"]), (" ↑1", AMBER), (" · ", MUTED), ("clean ", GREEN)])


def scene_deploy():
    browse(6, [("✓", GREEN, "Deploying to production", "2m ago"), ("✓", GREEN, "Deploying with vercel", "18m ago"),
               ("✗", RED, "Deploying to production", "1h ago")], ACCENT["DEPLOY"], "runs", [
        [[("$ ", MUTED), ("vercel --prod", BRIGHT, True)],
         [("  ~/app · 41s · exit 0", MUTED)], RULE,
         [("Vercel CLI 44.2.0", MUTED)],
         [("Inspect: ", TEXT), ("https://vercel.com/acme/app/9Ft2", CYAN)],
         [("Production: ", TEXT), ("https://app.vercel.app", CYAN), (" [41s]", MUTED)], [],
         [("Aliased ", TEXT), ("https://app.example.com", CYAN)]],
        [[("$ ", MUTED), ("vercel", BRIGHT, True)],
         [("  ~/app · 37s · exit 0", MUTED)], RULE,
         [("Vercel CLI 44.2.0", MUTED)],
         [("Inspect: ", TEXT), ("https://vercel.com/acme/app/4kQw", CYAN)],
         [("Preview: ", TEXT), ("https://app-git-feat-refresh.vercel.app", CYAN)], [],
         [("To deploy to production, run ", MUTED), ("vercel --prod", TEXT)]],
        [[("$ ", MUTED), ("vercel --prod", BRIGHT, True)],
         [("  ~/app · 22s · ", MUTED), ("exit 1", RED)], RULE,
         [("Vercel CLI 44.2.0", MUTED)],
         [("Error: ", RED), ("Command \"npm run build\" exited with 1", TEXT)], [],
         [("Type error: Property 'family' does not exist", TEXT)],
         [("on type 'TokenRecord'.", TEXT)]],
    ], RUN_KEYS)


# In the order of the tabs.
scenes = [scene_agents, scene_jobs, scene_servers, scene_build, scene_test, scene_git, scene_deploy]
for i, draw in enumerate(scenes):
    layer("s", i, draw)
layers("s", len(scenes), CYCLE, SCENE_TIMES)
layers("t", CYCLE, CYCLE)                                    # what ticks each second
layers("b", len(BRAILLE), round(len(BRAILLE) / 8, 3))        # the deck's spinner
layers("p", len(SPINNER), round(len(SPINNER) * SPIN_SECS, 2))  # Claude Code's spinner
css.append("@media (prefers-reduced-motion:reduce){.s,.p,.t,.b{animation:none}}")

print(f'<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 {W:.0f} {H:.0f}" '
      f'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, \'Liberation Mono\', monospace" '
      f'font-size="{FS}">')
print(f"<style>{''.join(css)}</style>")
print("\n".join(out))
print("</svg>")
