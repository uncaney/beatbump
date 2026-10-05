"""Embed a cover.png (or cover.jpg) found in each album folder into every .opus file
of that folder as a Vorbis METADATA_BLOCK_PICTURE (what players and the bridge's
/cover endpoint read). Used by fixtures/make-sample-library.sh, which runs it in a
throwaway python container because ffmpeg's ogg muxer cannot write attached pictures.

    python embed-cover.py <library root>

Idempotent: files that already carry a picture are left untouched.
"""
import base64
import os
import sys

from mutagen.flac import Picture
from mutagen.oggopus import OggOpus


def embed(opus_path, cover_path):
    f = OggOpus(opus_path)
    if f.tags and f.tags.get("metadata_block_picture"):
        return False
    with open(cover_path, "rb") as fh:
        data = fh.read()
    pic = Picture()
    pic.data = data
    pic.type = 3  # front cover
    pic.mime = "image/png" if cover_path.lower().endswith(".png") else "image/jpeg"
    pic.desc = "Cover"
    f.tags["metadata_block_picture"] = [base64.b64encode(pic.write()).decode("ascii")]
    f.save()
    return True


def main(root):
    done = 0
    for dirpath, _dirs, files in os.walk(root):
        cover = next((os.path.join(dirpath, c) for c in ("cover.png", "cover.jpg")
                      if c in files), None)
        if not cover:
            # a disc folder inherits the album folder's cover
            parent = os.path.join(os.path.dirname(dirpath))
            cover = next((os.path.join(parent, c) for c in ("cover.png", "cover.jpg")
                          if os.path.isfile(os.path.join(parent, c))), None)
        if not cover:
            continue
        for fn in sorted(files):
            if fn.lower().endswith(".opus") and embed(os.path.join(dirpath, fn), cover):
                done += 1
    print(f"[embed-cover] embedded art into {done} files under {root}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
