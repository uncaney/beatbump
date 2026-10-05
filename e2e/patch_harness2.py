#!/usr/bin/env python3
# Patch idempotent des deux harness e2e : plus de crash sur promesse orpheline
# (waitForResponse / waitForEvent crees avant un clic qui echoue), et log des
# rejets non geres au lieu d un exit brutal avant l ecriture de report.json.
import pathlib, sys
E2E = pathlib.Path("/srv/beatbump/e2e")
GUARD = 'process.on("unhandledRejection", (e) => console.log("UNHANDLED", String((e && e.message) || e)));\n'

def patch(name, anchors):
    p = E2E / name
    s = p.read_text(); orig = s
    if "unhandledRejection" not in s:
        s = s.replace('const path = require("path");\n', 'const path = require("path");\n' + GUARD, 1)
    for anchor, guard in anchors:
        if anchor in s and guard not in s:
            s = s.replace(anchor, anchor + "\n" + guard, 1)
        elif anchor not in s:
            print(f"{name}: ANCRE INTROUVABLE: {anchor[:60]}"); sys.exit(1)
    if s != orig:
        p.write_text(s); print(f"{name}: patche")
    else:
        print(f"{name}: deja a jour")

patch("harness.cjs", [
    ('    const wait = page.waitForResponse((r) => STREAM_RE.test(r.url()), { timeout: 25000 });',
     '    wait.catch(() => {});'),
])
patch("harness-offline.cjs", [
    ('    const wait = page.waitForResponse((r) => STREAM_RE.test(r.url()), { timeout: 30000 });',
     '    wait.catch(() => {});'),
    ('    const dl = page.waitForEvent("download", { timeout: 30000 });',
     '    dl.catch(() => {});'),
])
