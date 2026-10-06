# Stack verification

- Date: 2026-10-05 (11:30 to 11:45 UTC)
- Box: `docker-host` (hostname `docker-host`, Linux, Docker Compose v5.1.4, load average 30-35 during the run)
- Commit under test: `8a32dd1` (branch `ship`; the `beatbump` image was built at `674ecf9`, the Go/app
  sources did not change between the two, only `indexer/` and `up.sh`)
- Sandbox: `git clone -b ship /srv/beatbump/agents/ship /srv/beatbump/agents/ship-sandbox/beatbump`
  run with `COMPOSE_PROJECT_NAME=bbship`, so nothing collides with the production project `ytm`.
- Port: the brief asked for 18080, but 18080 is held by an unrelated `monerod` container on this box,
  so the sandbox publishes **18081**. Everything below uses `http://127.0.0.1:18081`.

## 1. One command, fresh clone

```
$ cd /srv/beatbump/agents/ship-sandbox/beatbump
$ BEATBUMP_PORT=18081 COMPOSE_PROJECT_NAME=bbship ./up.sh --sample-library
[up.sh] created deploy/.env from deploy/.env.example
[up.sh] generated MEILI_MASTER_KEY (64 chars)
[up.sh] generated COMPANION_SECRET_KEY (16 chars)
[up.sh] generated YTM_ADMIN_TOKEN (64 chars)
[up.sh] data: .../deploy/data (owner 1000:1000), music: .../deploy/data/music
[up.sh] generating the sample library in .../deploy/data/music/sample (needs the ffmpeg + python images)
[sample] rendering 18 tracks + 6 covers with linuxserver/ffmpeg into .../deploy/data/music/sample
[sample] embedding cover art with mutagen (python:3.12-slim)
[embed-cover] embedded art into 18 files under /out
[sample] done: 18 tracks in .../deploy/data/music/sample
[up.sh] building images (first build takes several minutes)
[up.sh] starting the stack (project bbship)
[up.sh] waiting for the stack to become healthy (up to 600s)
[up.sh] all containers running and healthy after 5s
  bbship-beatbump-1                        running    healthy
  bbship-bgutil-1                          running    healthy
  bbship-bridge-1                          running    healthy
  bbship-companion-1                       running    healthy
  bbship-indexer-1                         running    none
  bbship-meili-1                           running    healthy
  bbship-yubal-1                           running    healthy

  Beatbump is up:        http://localhost:18081/
  Library stats:         http://localhost:18081/api/v1/stats/library
  Admin token:           .../deploy/.env  (YTM_ADMIN_TOKEN, 64 chars)
  Music folder:          .../deploy/data/music   (indexed every 300s)
```

The first build (node + go app, bridge, indexer, yubal with deno) took about 3 minutes on this loaded
box. The sample library generation took 11 s.

`COMPANION_SECRET_KEY` is 16 characters, not 32 bytes of hex: invidious-companion refuses any other
length (verified against the config.example.toml shipped in the image and the production key length).

## 2. Containers

```
$ docker compose -p bbship --project-directory deploy -f deploy/compose.yml ps
NAME                 IMAGE                                          COMMAND                  SERVICE     STATUS                   PORTS
bbship-beatbump-1    bbship-beatbump                                "/app/beat-server"       beatbump    Up 2 minutes (healthy)   0.0.0.0:18081->8080/tcp
bbship-bgutil-1      brainicism/bgutil-ytdlp-pot-provider:1.3.1     "/usr/local/bin/node…"   bgutil      Up 2 minutes (healthy)   4416/tcp
bbship-bridge-1      bbship-bridge                                  "python bridge.py"       bridge      Up 2 minutes (healthy)
bbship-companion-1   quay.io/invidious/invidious-companion:latest   "/tini -- /app/invid…"   companion   Up 2 minutes (healthy)   8282/tcp
bbship-indexer-1     bbship-indexer                                 "python -u indexer.py"   indexer     Up 8 seconds
bbship-meili-1       getmeili/meilisearch:v1.12                     "tini -- /bin/sh -c …"   meili       Up 2 minutes (healthy)   7700/tcp
bbship-yubal-1       bbship-yubal                                   "/entrypoint.sh pyth…"   yubal       Up 2 minutes (healthy)   8000/tcp
```

Only `beatbump` publishes a host port (`docker ps --format '{{.Names}} {{.Ports}}'` shows
`0.0.0.0:18081->8080/tcp` for beatbump and internal ports only for the others). The indexer has no
HTTP endpoint, hence no healthcheck.

## 3. Library indexed (tracks > 0)

```
$ curl -s http://127.0.0.1:18081/api/v1/stats/library
{"version": "674ecf9", "tracks": 19, "albums": 7, "artists": 5, ...}

$ docker compose ... logs indexer
[indexer] root=/music sources=* state=/state/index_state.json interval=300s
[indexer] coverage: {"sample": {"files": 18, "new": 18}, "ytm": {"files": 1, "new": 1}, "local": {"files": 0, "new": 0}}
[indexer] derived: albums=7 artists=5
[indexer] pass done in 5s

$ curl -s 'http://127.0.0.1:18081/api/v1/local/artists?limit=20'   (titles)
artists total: 5 ['Bitfield', 'Low Pass Orchestra', 'Noise Floor', 'Rick Astley', 'The Sine Waves']
```

18 tracks are the sample library; the 19th (Rick Astley) was downloaded by yubal during this very
verification (section 7). Two indexer bugs were found and fixed on the way:

- the first pass aggregated albums/artists before Meilisearch had processed the upload
  (18 tracks, 0 albums): the derived rebuild now waits for the pending tasks (`3cadd53`);
- after `down -v` the state file on the bind mount claimed everything was indexed while the index
  volume was empty (0 tracks): the indexer now re-scans when the index is empty (`8a32dd1`).

## 4. App shell

```
$ curl -sI http://127.0.0.1:18081/
HTTP/1.1 200 OK
Cache-Control: no-cache
Content-Length: 3226
Content-Type: text/html; charset=utf-8
Etag: W/"5d360acfa0cd199a1d18"

$ curl -s http://127.0.0.1:18081/ | head -c 120
<!DOCTYPE html>
<html
	lang="fr"
	class=""
>
	<head>
		<meta charset="utf-8" />
```

## 5. Local search, local stream, cover

The app's own endpoints (`app/src` calls `api/v1/local/songs?q=`, audio on `/localf?p=`, covers on
`/cover?lid=`, all same-origin and reverse-proxied by the Go server to the bridge):

```
$ curl -s 'http://127.0.0.1:18081/api/v1/local/songs?q=Fifth&limit=3'
{"items": [{"title": "Fifth Partial", "videoId": "fded1c11774", "length": "0:22",
  "album": {"text": "Harmonic Series", "browseId": "lb-a0a7a4c45ac5...."},
  "artistInfo": {"artist": [{"text": "The Sine Waves", "browseId": "la-7cbfda6665ac"}]},
  "thumbnails": [{"url": "/cover?lid=fded1c11774", ...}], "type": "song"}], "total": 1, ...}

$ curl -sI -H 'Range: bytes=0-1023' "http://127.0.0.1:18081/localf?p=sample%2FThe%20Sine%20Waves%2FHarmonic%20Series%2FDisc%202%2F02%20-%20Fifth%20Partial.opus"
HTTP/1.1 206 Partial Content
Content-Length: 1024
Content-Range: bytes 0-1023/421661
Content-Type: audio/ogg
X-Ytm-Source: local
full body bytes: 421661
magic:  O g g S

$ curl -sI "http://127.0.0.1:18081/cover?lid=fded1c11774"
HTTP/1.1 200 OK
Content-Length: 86531
Content-Type: image/png
X-Ytm-Cover: MISS            (HIT on the second request: disk cache in deploy/data/bridge-state/covers)
png magic:  89 50 4e 47 0d 0a 1a 0a
```

The Meilisearch document behind that track (tags read by the indexer from the generated file):

```
{"title": "Fifth Partial", "artist": "The Sine Waves", "album": "Harmonic Series", "lid": "fded1c11774",
 "year": "2021", "genre": "Ambient", "track": 2, "durationSec": 22,
 "path": "sample/The Sine Waves/Harmonic Series/Disc 2/02 - Fifth Partial.opus", "source": "sample"}
```

## 6. YouTube search

`/api/v1/search.json` is answered by the Go server talking to music.youtube.com directly (companion is
only used for the player); the result merges a local shelf when the query matches the library.

```
$ curl -s 'http://127.0.0.1:18081/api/v1/search.json?q=daft+punk'
http 200 bytes 25542 time 0.578898s
top keys: ['results', 'continuation']
titles found: 30 first: ['Results', 'Random Access Memories', 'Discovery', 'Alive 2007', 'Aerodynamic', 'Touch (feat. Camille Williams)']
```

## 7. YouTube player through bridge -> companion, direct egress, auto-cache

First call (track not in the library): companion answers, the bridge rewrites the audio to the
app's same-origin `/vp` proxy, and `/vp` fetches googlevideo **without any proxy**:

```
$ curl -s 'http://127.0.0.1:18081/api/v1/player.json?videoId=dQw4w9WgXcQ'
http 200 bytes 85855 time 0.664121s
playabilityStatus: OK
audio formats: 4 first url: /vp?u=https%3A%2F%2Frr2---sn-n4g-cvq6.googlevideo.com%2Fvideoplayback%3Fexpire%3...

$ curl -s -r 0-65535 -o /dev/null -w "http %{http_code} bytes %{size_download} ctype %{content_type}\n" "http://127.0.0.1:18081/vp?u=..."
http 206 bytes 65536 ctype audio/mp4 time 0.171296s

companion-1  | <-- POST /companion/youtubei/v1/player
companion-1  | [INFO] Successfully generated PO token
companion-1  | --> POST /companion/youtubei/v1/player 200 635ms
bridge-1     | [player] dQw4w9WgXcQ -> vp
```

That play enqueued a yubal download (bgutil PO token + deno, direct egress), which landed in
`MUSIC_DIR/ytm` and was indexed on the next pass:

```
yubal-1  | yubal.services.playlist_download_service - Track download complete
$ find deploy/data/music/ytm -type f
deploy/data/music/ytm/Rick Astley/1987 - Whenever You Need Somebody/01 - Never Gonna Give You Up.opus
deploy/data/music/ytm/Rick Astley/1987 - Whenever You Need Somebody/01 - Never Gonna Give You Up.lrc
```

Second call of the same video, after the indexer pass: the bridge serves the local copy (local-first):

```
$ curl -s 'http://127.0.0.1:18081/api/v1/player.json?videoId=dQw4w9WgXcQ'
playabilityStatus: OK
audio formats: 4 first url: /localf?p=ytm%2FRick%20Astley%2F1987%20-%20Whenever%20You%20Need%20Somebody%2F01...
bridge-1  | [player] dQw4w9WgXcQ -> local ytm/Rick Astley/1987 - Whenever You Need Somebody/01 - Never Gonna Give You Up.opus
$ curl -s -r 0-65535 ... "http://127.0.0.1:18081/localf?p=ytm%2F..."
http 206 bytes 65536 ctype audio/ogg time 0.009390s
```

## 8. Generic bridge behaviour

```
bridge-1  | [bridge] listening on :8789 companion=http://companion:8282 yubal=http://yubal:8000 ivvp=off invidious=off proxy=direct bases vp=/vp localf=/localf aud=/aud
bridge-1  | [la] loaded 1 entries (dropped 0 stale, 0 touched during load)      <- background, after the listener is up

$ docker compose ... exec bridge python -c 'urlopen("http://127.0.0.1:8789/iv/api/v1/videos/dQw4w9WgXcQ")'
HTTP 502 b'invidious upstream not configured (INVIDIOUS_UPSTREAM)'
```

## 9. Clean re-run

```
$ COMPOSE_PROJECT_NAME=bbship ./up.sh down -v
 Volume bbship_companion-cache Removed
 Volume bbship_meili-data Removed
 Network bbship_default Removed
$ COMPOSE_PROJECT_NAME=bbship ./up.sh          (second run: deploy/.env kept, images cached)
[up.sh] all containers running and healthy after 10s
real 0m30.587s
$ curl -s http://127.0.0.1:18081/api/v1/stats/library
{"version": "674ecf9", "tracks": 19, "albums": 7, "artists": 5}
```

## State at the end of this verification

The sandbox stack `bbship` is **left running** at `http://127.0.0.1:18081/` (project `bbship`,
clone at `/srv/beatbump/agents/ship-sandbox/beatbump`, commit `8a32dd1`) for the browser
harness. Stop it with `cd /srv/beatbump/agents/ship-sandbox/beatbump && COMPOSE_PROJECT_NAME=bbship ./up.sh down -v`.

## Known limitations (outside the packaged paths)

- `backend/_youtube/api/api.go` `getResidentialHttpClient()` falls back to `http://gost:8888` when
  `RESIDENTIAL_PROXY` is empty. Only `NextResidential` (background auto-cache "next" lookups) uses it;
  in a stack without a proxy those lookups fail quietly. The Go default should become "direct when
  empty"; the compose file already passes `RESIDENTIAL_PROXY=${EGRESS_PROXY:-}`.
- `YTM_PREFER_IVVP_AUDIO=0` is set in compose: without it the Go server reroutes every `/vp` audio
  URL to `/aud/<id>`, which only exists with an iv-vp sidecar.
- Camille's production compose must now set the bridge variables explicitly to keep its behaviour, since
  the bridge defaults are generic: `GOST_PROXY`, `IVVP_UPSTREAM`, `INVIDIOUS_UPSTREAM`,
  `VP_PUBLIC_BASE`, `LOCALF_PUBLIC_BASE`, `AUD_PUBLIC_BASE`; yubal needs `YTM_YTDLP_PROXY`.

## Release verification: clean clone of the final code (2026-10-06)

The 1.0.0 gate. A brand-new `git clone` of the release branch, nothing reused
from earlier sandboxes (`./up.sh down -v` first), one command, then the full
browser harness with the sample-library fixtures. Host: docker-host (32 cores,
load 30 to 50 during the run).

```sh
git clone <repo> beatbump && cd beatbump
BEATBUMP_PORT=18081 COMPOSE_PROJECT_NAME=bbship ./up.sh --sample-library
cd e2e
HARNESS_FIXTURES=fixtures.sample.json HARNESS_TIER=chain ./run.sh http://127.0.0.1:18081 "" harness-smoke.cjs
HARNESS_FIXTURES=fixtures.sample.json HARNESS_TIER=chain ./run.sh http://127.0.0.1:18081 "" harness-core.cjs
HARNESS_FIXTURES=fixtures.sample.json HARNESS_TIER=chain ./run.sh http://127.0.0.1:18081 "" harness-offline.cjs
```

| Check | Result |
| --- | --- |
| `./up.sh --sample-library` | exit 0 in 63 s with warm image layers (253 s on the first build of this host); 7 containers running, 6 healthy + indexer (no HTTP endpoint) |
| First index pass | `{"tracks":45,"albums":19,"artists":9}` reported by `up.sh` before it prints the URL |
| Smoke | `Report: 5 passed / 0 failed / 0 upstream / 0 skipped` |
| Core (chain tier) | `Report: 93 passed / 0 failed / 0 upstream / 2 skipped` |
| Offline | `Report: 20 passed / 0 failed / 0 upstream / 0 skipped` |

Skips, both expected on a fresh install: `perf_api_caches` and
`nonlocal_track_plays` need a YouTube track already acquired into the library
(`acquiredVideoId` fixture). Three more steps are full-tier only
(`buttons_readable`, `french_program_screens`, `pack_refresh_preview`) and are
not counted in the chain tier.

The same harness run against the original production instance (56k tracks,
production fixtures, chain tier) on 2026-10-05: core 95 / 0 / 0 / 0, offline
20 / 0 / 0 / 0: no step skipped there.

What the clean-clone runs found and fixed before this result (a sandbox grown
across fixes had hidden them):

- an empty mix list cached at boot, served for minutes then STALE for a day
  (`NoStoreHeader`, `d1cf0b6`);
- `up.sh` declared the stack ready before the first index pass (`d1cf0b6`) and
  printed counts before the derived albums landed (`b633e80`);
- the first-pack step assumed the pack was still running when the Espace page
  mounted; on a small library it is already done (`b633e80`).
