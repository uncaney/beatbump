#!/usr/bin/env python3
# Patch idempotent de e2e/harness.cjs :
#  - accepte --resolver="MAP *.ekaii.fr 127.0.0.1" -> --host-resolver-rules (hairpin casse)
#  - STREAM_RE reconnait aussi /aud (repli iv-vp) et les chemins same-origin
import pathlib, sys
p = pathlib.Path("/srv/beatbump/e2e/harness.cjs")
s = p.read_text()
orig = s
if 'arg("resolver"' not in s:
    s = s.replace('const REPEAT = parseInt(arg("repeat", "1"), 10);',
                  'const REPEAT = parseInt(arg("repeat", "1"), 10);\nconst RESOLVER = arg("resolver", "");', 1)
old_args = 'args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage"],'
new_args = ('args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage",\n'
            '      ...(RESOLVER ? ["--host-resolver-rules=" + RESOLVER] : [])],')
if "host-resolver-rules" not in s:
    if old_args not in s:
        print("ANCRE args introuvable"); sys.exit(1)
    s = s.replace(old_args, new_args, 1)
old_re = 'const STREAM_RE = /(videoplayback|googlevideo|\\/localf|\\/vp\\?|stream|\\.m4a|\\.opus|\\.webm|range)/i;'
new_re = 'const STREAM_RE = /(videoplayback|googlevideo|\\/localf|\\/vp\\?|\\/aud\\/|stream|\\.m4a|\\.opus|\\.webm|range)/i;'
if "\\/aud\\/" not in s:
    if old_re not in s:
        print("ANCRE STREAM_RE introuvable"); sys.exit(1)
    s = s.replace(old_re, new_re, 1)
if s != orig:
    p.write_text(s); print("harness.cjs patche")
else:
    print("harness.cjs deja a jour")
