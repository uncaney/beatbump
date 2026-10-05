#!/usr/bin/env python3
"""Journal of a promotion: CHANGELOG.md entry + CYCLES.md line (cycle 34 OP2).

Usage: python3 ops/journal.py <cycle> <head> [--chain <N>] [--dry-run]
  <cycle> : cycle identifier (33, 21b, ...); the text comes from ops/journal/cycle-<cycle>.md
  <head>  : promoted short SHA, e.g. b8e98f4
  --chain : number of the green staging chain, required when the text contains {chain}
  --dry-run : prints what would be written, writes nothing

Both files live in $YTM_PROGRAM_DIR (ops/env.sh; default ops/program next to this script) and are created
with a one-line header when absent.
  - the entry is appended to CHANGELOG.md only when its marker is not already in a "## " heading of
    CHANGELOG.md (idempotent);
  - the CYCLES.md line (meta "cycles:") is appended only when its marker ("cycles-marker:", else the whole
    line) is not already in a "- " line of CYCLES.md.
Guards (cycle 39, L11-14): <head> must be a short sha (^[0-9a-f]{7,12}$); "cycles-marker:" is mandatory when
"cycles:" contains {now}, {date} or {time} (otherwise a rerun would add a second line); any {xxx} token without
a value stops the script BEFORE any write. Running the same cycle / head again changes nothing and says so
("nothing to write"). --dry-run prints the exact lines that would be appended.

Format of a cycle-<N>.md file (a new cycle = a new text file, no code):
  <!-- marker: cycle 34 in prod -->                       (default: "cycle <N> in prod")
  <!-- cycles: - {now}: chain {chain} ({head}) green; promoted (cycle 34: c34a + c34b). -->   (optional)
  <!-- cycles-marker: chain {chain} ({head}) green -->   (optional)
  ## {date} {time} UTC (host clock): cycle 34 in prod (integration {head}): title
  - bullet 1
  - bullet 2
Tokens replaced (literal replacement, not Python formatting): {head}, {chain}, {date} = date -u YYYY-MM-DD,
{time} = HH:MM, {now} = "HH:MM UTC DD/MM (host clock)" (CYCLES.md convention since the timestamp fix of
2026-10-01 17:21 UTC).
"""
import datetime
import os
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
PROGRAM = pathlib.Path(os.environ.get("YTM_PROGRAM_DIR") or (HERE / "program"))
DATA = HERE / "journal"
META_RE = re.compile(r"^<!--\s*([a-z-]+):\s?(.*?)\s*-->\s*$")
HEADERS = {"CHANGELOG.md": "# CHANGELOG (written by ops/journal.py at each promotion)\n",
           "CYCLES.md": "# CYCLES (one line per green chain / promotion, written by ops/journal.py)\n"}


def parse(path):
    meta, body = {}, []
    lines = path.read_text().splitlines(keepends=True)
    i = 0
    while i < len(lines):
        m = META_RE.match(lines[i])
        if not m:
            break
        meta[m.group(1)] = m.group(2)
        i += 1
    body = "".join(lines[i:])
    return meta, body


def fill(text, tokens):
    for k, v in tokens.items():
        text = text.replace("{" + k + "}", v)
    left = re.findall(r"\{([a-z][a-z_-]*)\}", text)
    if left:
        sys.exit(f"token without a value: {{{left[0]}}} (pass --chain?)")
    return text


def ensure(path):
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(HEADERS.get(path.name, ""))


def present(path, marker, prefix):
    """Is the marker already in a line starting with prefix? Returns that line or None."""
    for l in path.read_text().splitlines():
        if l.startswith(prefix) and marker in l:
            return l
    return None


def append_once(path, marker, block, prefix, dry):
    ensure(path)
    hit = present(path, marker, prefix)
    if hit is not None:
        print(f"{path.name}: already present, nothing to write ({marker}): {hit[:160]}")
        return False
    if dry:
        print(f"--- {path.name}: exact lines that would be appended (dry-run) ---")
        sys.stdout.write(block if block.endswith("\n") else block + "\n")
        print(f"--- end {path.name} ---")
        return True
    s = path.read_text()
    tmp = path.with_suffix(path.suffix + ".tmp-journal")
    tmp.write_text(s.rstrip("\n") + "\n" + block)
    tmp.replace(path)
    print(f"{path.name}: appended ({marker})")
    return True


def main(argv):
    args, dry, chain, it = [], False, None, iter(argv)
    for a in it:
        if a == "--dry-run":
            dry = True
        elif a == "--chain":
            chain = next(it, None)
            if chain is None:
                sys.exit("--chain without a value")
        else:
            args.append(a)
    if len(args) != 2:
        sys.exit(__doc__.split("\n\n")[1])
    cycle, head = args
    if not re.fullmatch(r"[0-9a-f]{7,12}", head):
        sys.exit(f"invalid head: {head!r} (expected a short sha, ^[0-9a-f]{{7,12}}$)")
    if chain is not None and not re.fullmatch(r"[0-9]+[a-z]?", chain):
        sys.exit(f"invalid --chain: {chain!r} (expected a chain number, e.g. 41)")
    src = DATA / f"cycle-{cycle}.md"
    if not src.is_file():
        sys.exit(f"text missing: {src} (create this file, see the format in journal.py)")
    meta, body = parse(src)
    now = datetime.datetime.now(datetime.timezone.utc)
    tokens = {"head": head, "date": now.strftime("%Y-%m-%d"), "time": now.strftime("%H:%M"),
              "now": now.strftime("%H:%M UTC %d/%m") + " (host clock)"}
    if chain is not None:
        tokens["chain"] = chain
    marker = fill(meta.get("marker", f"cycle {cycle} in prod"), tokens)
    entry = "\n" + fill(body.strip("\n"), tokens) + "\n"
    if marker not in entry:
        sys.exit(f"the marker {marker!r} does not appear in the text of {src.name}")
    line = cmark = None
    if "cycles" in meta:  # filled BEFORE any write: a missing token writes nothing
        if "cycles-marker" not in meta and re.search(r"\{(now|date|time)\}", meta["cycles"]):
            sys.exit(f"{src.name}: 'cycles-marker:' is mandatory when 'cycles:' contains {{now}}/{{date}}/{{time}} "
                     "(otherwise a rerun adds a second line); nothing was written")
        line = fill(meta["cycles"], tokens)
        cmark = fill(meta.get("cycles-marker", line), tokens)
        if not cmark.strip():
            sys.exit(f"{src.name}: empty 'cycles-marker:'; nothing was written")
    changed = append_once(PROGRAM / "CHANGELOG.md", marker, entry, "## ", dry)
    if line:
        changed = append_once(PROGRAM / "CYCLES.md", cmark, line + "\n", "- ", dry) or changed
    if not changed:
        print(f"journal {cycle}: nothing to write, cycle {cycle} already journaled (CHANGELOG.md and CYCLES.md unchanged)")
    else:
        print(f"journal {cycle} ok" + (" (dry-run: nothing written)" if dry else ""))


if __name__ == "__main__":
    main(sys.argv[1:])
