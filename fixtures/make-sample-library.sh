#!/usr/bin/env bash
# Generate a small CC0 synthetic music library (18 opus tracks, 20-38 s each,
# 4 artists, 6 albums incl. one 2-disc album and one single) with full tags and
# embedded cover art, so a fresh Beatbump install has content to show.
#
#   fixtures/make-sample-library.sh [OUT_DIR]      (default: fixtures/sample-library)
#
# ffmpeg is not required on the host: audio and covers are rendered inside the
# linuxserver/ffmpeg image, and the covers are embedded with mutagen inside a
# python:3.12-slim container (ffmpeg's ogg muxer cannot write attached pictures).
# Override the images with FFMPEG_IMAGE / PYTHON_IMAGE. Idempotent: re-running
# regenerates the files in place. Everything here is synthetic (sine, square,
# noise, sweeps) and released under CC0 1.0.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-$HERE/sample-library}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
FFMPEG_IMAGE=${FFMPEG_IMAGE:-linuxserver/ffmpeg}
PYTHON_IMAGE=${PYTHON_IMAGE:-python:3.12-slim}
UIDGID="$(id -u):$(id -g)"

command -v docker >/dev/null 2>&1 || { echo "[sample] docker is required" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/beatbump-sample.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
GEN="$WORK/gen.sh"
printf '#!/bin/sh\nset -e\n' > "$GEN"
COUNT=0

# album "Artist" "Album" "c0" "c1" "gradient type"  -> folder + cover.png command
album() {
    local dir="$OUT/$1/$2"
    mkdir -p "$dir"
    printf 'ffmpeg -y -loglevel error -f lavfi -i "gradients=s=600x600:c0=%s:c1=%s:n=2:type=%s:x0=60:y0=60:x1=540:y1=540" -frames:v 1 "%s/cover.png"\n' \
        "$3" "$4" "$5" "/out/$1/$2" >> "$GEN"
}

# track "Artist" "Album" year genre disc ndisc n ntracks "Title" seconds "lavfi source"
track() {
    local artist=$1 albumname=$2 year=$3 genre=$4 disc=$5 ndisc=$6 n=$7 ntracks=$8 title=$9 dur=${10} src=${11}
    local sub="" fade_out
    if [ "$ndisc" -gt 1 ]; then sub="/Disc $disc"; mkdir -p "$OUT/$artist/$albumname$sub"; fi
    fade_out=$((dur - 2))
    printf 'ffmpeg -y -loglevel error -f lavfi -i "%s" -t %s -af "volume=0.6,afade=t=in:st=0:d=1,afade=t=out:st=%s:d=2" -ar 48000 -ac 2 -c:a libopus -b:a 96k -metadata title="%s" -metadata artist="%s" -metadata album_artist="%s" -metadata album="%s" -metadata date="%s" -metadata genre="%s" -metadata track="%s/%s" -metadata disc="%s/%s" -metadata comment="Synthetic CC0 sample track (Beatbump fixtures)" "%s/%02d - %s.opus"\n' \
        "$src" "$dur" "$fade_out" "$title" "$artist" "$artist" "$albumname" "$year" "$genre" "$n" "$ntracks" "$disc" "$ndisc" \
        "/out/$artist/$albumname$sub" "$n" "$title" >> "$GEN"
    COUNT=$((COUNT + 1))
}

# ---- Catalogue ---------------------------------------------------------------
A="The Sine Waves"
album "$A" "Pure Tones" "0x1b2a49" "0x4fa3ff" linear
track "$A" "Pure Tones" 2019 Electronic 1 1 1 4 "A Four Forty" 24 "sine=frequency=440:sample_rate=48000"
track "$A" "Pure Tones" 2019 Electronic 1 1 2 4 "C Five"       22 "sine=frequency=523.25:sample_rate=48000"
track "$A" "Pure Tones" 2019 Electronic 1 1 3 4 "E Five"       26 "sine=frequency=659.25:sample_rate=48000"
track "$A" "Pure Tones" 2019 Electronic 1 1 4 4 "G Five"       20 "sine=frequency=783.99:sample_rate=48000"

album "$A" "Harmonic Series" "0x2d1b3f" "0xd98cff" radial
track "$A" "Harmonic Series" 2021 Ambient 1 2 1 2 "Fundamental"    24 "aevalsrc=0.5*sin(2*PI*110*t):s=48000"
track "$A" "Harmonic Series" 2021 Ambient 1 2 2 2 "Second Partial" 28 "aevalsrc=0.4*(sin(2*PI*110*t)+0.6*sin(2*PI*220*t)):s=48000"
track "$A" "Harmonic Series" 2021 Ambient 2 2 1 2 "Third Partial"  30 "aevalsrc=0.35*(sin(2*PI*110*t)+0.5*sin(2*PI*330*t)):s=48000"
track "$A" "Harmonic Series" 2021 Ambient 2 2 2 2 "Fifth Partial"  22 "aevalsrc=0.3*(sin(2*PI*110*t)+0.4*sin(2*PI*550*t)):s=48000"

A="Noise Floor"
album "$A" "White Light" "0x202020" "0xe0e0e0" circular
track "$A" "White Light" 2018 Experimental 1 1 1 3 "White" 25 "anoisesrc=color=white:amplitude=0.25:sample_rate=48000"
track "$A" "White Light" 2018 Experimental 1 1 2 3 "Pink"  30 "anoisesrc=color=pink:amplitude=0.3:sample_rate=48000"
track "$A" "White Light" 2018 Experimental 1 1 3 3 "Brown" 35 "anoisesrc=color=brown:amplitude=0.35:sample_rate=48000"

album "$A" "Static" "0x3a1f00" "0xffa040" spiral
track "$A" "Static" 2022 Experimental 1 1 1 1 "Static" 21 "anoisesrc=color=blue:amplitude=0.25:sample_rate=48000"

A="Bitfield"
album "$A" "Square Roots" "0x0b3d0b" "0x7cff5c" linear
track "$A" "Square Roots" 2020 Chiptune 1 1 1 3 "Square One"  22 "aevalsrc=0.3*sgn(sin(2*PI*220*t)):s=48000"
track "$A" "Square Roots" 2020 Chiptune 1 1 2 3 "Pulse Width" 24 "aevalsrc=0.3*sgn(sin(2*PI*330*t)+0.3):s=48000"
track "$A" "Square Roots" 2020 Chiptune 1 1 3 3 "Eight Bits"  20 "aevalsrc=0.3*sgn(sin(2*PI*440*t))*gt(mod(t\,0.5)\,0.1):s=48000"

A="Low Pass Orchestra"
album "$A" "Sweep" "0x4a0a2a" "0xff7ab6" radial
track "$A" "Sweep" 2023 Soundtrack 1 1 1 3 "Rising"  30 "aevalsrc=0.4*sin(2*PI*(80+t*12)*t):s=48000"
track "$A" "Sweep" 2023 Soundtrack 1 1 2 3 "Falling" 32 "aevalsrc=0.4*sin(2*PI*(900-t*20)*t):s=48000"
track "$A" "Sweep" 2023 Soundtrack 1 1 3 3 "Plateau" 38 "aevalsrc=0.35*sin(2*PI*196*t)*(0.6+0.4*sin(2*PI*0.25*t)):s=48000"
# -----------------------------------------------------------------------------

cat > "$OUT/README.txt" <<'EOF'
Beatbump sample library
=======================
18 synthetic tracks (sine, square, noise, sweeps) generated by
fixtures/make-sample-library.sh. Tagged with artist / album / title / year /
genre / track and disc numbers, with embedded cover art. Public domain (CC0 1.0):
delete this folder once you have real music in your library.
EOF

echo "[sample] rendering $COUNT tracks + 6 covers with $FFMPEG_IMAGE into $OUT"
docker run --rm --user "$UIDGID" -v "$OUT:/out" -v "$WORK:/work:ro" --entrypoint sh "$FFMPEG_IMAGE" /work/gen.sh

echo "[sample] embedding cover art with mutagen ($PYTHON_IMAGE)"
docker run --rm --user "$UIDGID" -e HOME=/tmp -v "$OUT:/out" -v "$HERE:/fx:ro" "$PYTHON_IMAGE" sh -c \
    'pip install -q --no-cache-dir --disable-pip-version-check --target /tmp/py "mutagen==1.47.0" >/dev/null && PYTHONPATH=/tmp/py python /fx/embed-cover.py /out'

n=$(find "$OUT" -type f -name '*.opus' | wc -l | tr -d ' ')
[ "$n" -eq "$COUNT" ] || { echo "[sample] expected $COUNT opus files, found $n" >&2; exit 1; }
echo "[sample] done: $n tracks in $OUT"
