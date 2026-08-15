#!/usr/bin/env python3
"""
Læg talerne og underholdningen ind i galleriet.

Kører fra jeres egen computer — ikke fra hjemmesiden. Hver video omkodes til
H.264/AAC i en MP4, som alle telefoner kan afspille, og lægges op sammen med et
still-billede, galleriet kan vise i gitteret.

Den kan afbrydes og startes igen. Hver fil får en checksum, og filer, der
allerede er lagt op, springes over.

    export SUPABASE_URL="https://xxxx.supabase.co"
    export SUPABASE_SERVICE_KEY="ey..."        # service_role — ALDRIG i git
    python3 tools/import_video.py ~/Film/bryllup --dry-run
    python3 tools/import_video.py ~/Film/bryllup

Kræver ffmpeg:

    brew install ffmpeg

Filnavnet bliver videoens titel på siden, så navngiv dem, før I kører:

    01 Brudens tale.mov      ->  "Brudens tale"
    02 Sang fra bordet 4.mp4 ->  "Sang fra bordet 4"

Videoerne lægges i deres EGEN spand (`video`), ikke sammen med billederne.
Se docs/supabase.md afsnit 4e — det er dét, der gør, at billedspanden kan blive
ved med at være spærret til 10 MB JPEG, som er den eneste grænse, en browser
ikke kan snakke sig uden om.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

# Skal matche CONFIG i photos.js, ellers dukker videoerne ikke op i galleriet.
DAY_FOLDER = "uploads/2026-08-15"
VIDEO_FOLDER = DAY_FOLDER + "/video"
BUCKET = "video"

# 1080p og ca. 4 Mbit/s. To timer bliver da ~3,5 GB i stedet for de 15-40 GB,
# kameraet leverer — og det er ikke pladsen, det handler om, men trafikken:
# hver gang en gæst ser en tale, sendes filen igen.
MAX_WIDTH = 1920
MAX_HEIGHT = 1080
CRF = 21
MAXRATE = "5M"
BUFSIZE = "10M"
AUDIO_BITRATE = "128k"

# Still-billedet bruges to steder: som lille felt i gitteret OG som det
# fyldskærmsbillede, man ser, indtil man trykker play. 480 px er rigeligt til
# feltet, men grødet i fuld skærm på en telefon, hvor der er tre skærmpunkter
# pr. billedpunkt. 960 px koster ~100 KB pr. video — med ti videoer er det
# intet mod selve filmene, og det er dét billede, folk møder først.
THUMB_EDGE = 960
POSTER_AT = 3.0          # sekunder inde i videoen still-billedet tages

SUFFIXES = {".mov", ".mp4", ".m4v", ".avi", ".mts", ".m2ts", ".mkv", ".wmv", ".3gp"}
TIMEOUT = 600            # en video er stor; upload må gerne tage sin tid


class Fatal(Exception):
    pass


# --------------------------------------------------------------------------
# HTTP  (samme fremgangsmåde som import_fotograf.py)
# --------------------------------------------------------------------------

def request(method, url, key, data=None, headers=None, retries=4):
    """Én HTTP-kald med backoff. Returnerer (status, body)."""
    last = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("apikey", key)
        req.add_header("Authorization", "Bearer " + key)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as e:
            body = e.read()
            # 4xx bortset fra 429 bliver ikke bedre af at prøve igen.
            if e.code < 500 and e.code != 429:
                return e.code, body
            last = "HTTP %s: %s" % (e.code, body[:300])
        except Exception as e:                      # timeout, netværk, DNS
            last = repr(e)
        if attempt < retries:
            time.sleep(min(2 ** attempt, 15))
    raise Fatal("%s %s slog fejl: %s" % (method, url.split("?")[0], last))


def upload(base, key, path, blob, content_type):
    status, body = request(
        "POST",
        "%s/storage/v1/object/%s/%s" % (base, BUCKET, path),
        key,
        data=blob,
        headers={
            "Content-Type": content_type,
            # Filnavnene er UUID'er, så indholdet ændrer sig aldrig. Det her er
            # også en trafikbremse: ser to gæster den samme tale, henter den
            # anden den fra CDN'et i stedet for fra Supabase.
            "Cache-Control": "public, max-age=31536000, immutable",
            "x-upsert": "true",
        },
    )
    if status >= 300:
        if status == 404:
            raise Fatal(
                "Spanden '%s' findes ikke. Opret den i Supabase først —\n"
                "se docs/supabase.md afsnit 4e." % BUCKET
            )
        if status == 413:
            raise Fatal(
                "%s er større end spandens grænse. Sæt 'File size limit' på\n"
                "spanden '%s' op — se docs/supabase.md afsnit 4e." % (path, BUCKET)
            )
        raise Fatal("upload af %s: HTTP %s %s" % (path, status, body[:200]))


def existing_hashes(base, key):
    """Alle checksummer, der allerede er lagt ind — det er dem, vi springer over."""
    seen = set()
    step = 1000
    offset = 0
    while True:
        status, body = request(
            "GET",
            "%s/rest/v1/photos?select=import_hash&import_hash=not.is.null"
            "&limit=%d&offset=%d" % (base, step, offset),
            key,
        )
        if status == 400:
            raise Fatal(
                "Kolonnen import_hash findes ikke endnu.\n"
                "Kør SQL-blokkene i docs/supabase.md afsnit 4c og 4d først."
            )
        if status >= 300:
            raise Fatal("kunne ikke hente eksisterende filer: HTTP %s %s" % (status, body[:200]))
        rows = json.loads(body)
        for r in rows:
            if r.get("import_hash"):
                seen.add(r["import_hash"])
        if len(rows) < step:
            return seen
        offset += step


# --------------------------------------------------------------------------
# ffmpeg
# --------------------------------------------------------------------------

def run(cmd):
    """Kør ffmpeg/ffprobe og giv en brugbar fejl, hvis det går galt."""
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise Fatal("%s fejlede:\n    %s" % (cmd[0], "\n    ".join(tail[-4:])))
    return proc.stdout


def probe(path):
    """Længde, mål og optagetidspunkt."""
    raw = run(["ffprobe", "-v", "error", "-print_format", "json",
               "-show_format", "-show_streams", str(path)])
    data = json.loads(raw)

    stream = None
    for s in data.get("streams", []):
        if s.get("codec_type") == "video":
            stream = s
            break
    if stream is None:
        raise Fatal("ingen videostrøm i filen")

    duration = data.get("format", {}).get("duration") or stream.get("duration")
    tags = {}
    tags.update(data.get("format", {}).get("tags") or {})
    tags.update(stream.get("tags") or {})

    return {
        "duration": float(duration) if duration else 0.0,
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "created": tags.get("creation_time"),
    }


def transcode(src, dest):
    """
    H.264 High + AAC i MP4 — den ene kombination, alt kan afspille.

    +faststart flytter indholdsfortegnelsen om foran i filen. Uden den kan
    afspilningen først begynde, når HELE filen er hentet, og en tale på ti
    minutter ser ud som om siden er gået i stå.
    """
    run([
        "ffmpeg", "-y", "-nostdin", "-loglevel", "error",
        "-i", str(src),
        "-vf", ("scale='min(%d,iw)':'min(%d,ih)'"
                ":force_original_aspect_ratio=decrease"
                ":force_divisible_by=2" % (MAX_WIDTH, MAX_HEIGHT)),
        "-c:v", "libx264", "-profile:v", "high", "-level", "4.0",
        "-pix_fmt", "yuv420p", "-preset", "slow",
        "-crf", str(CRF), "-maxrate", MAXRATE, "-bufsize", BUFSIZE,
        "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ac", "2",
        "-movflags", "+faststart",
        str(dest),
    ])


def poster(src, dest, duration):
    """
    Still-billede til gitteret. Tages fra den FÆRDIGE fil, så billedet vender
    samme vej som videoen — telefoner gemmer tit rotationen ved siden af
    billeddataene, og så ligger stillbilledet ned, mens videoen står op.
    """
    at = POSTER_AT if duration > POSTER_AT * 2 else max(duration / 2.0, 0)
    run([
        "ffmpeg", "-y", "-nostdin", "-loglevel", "error",
        "-ss", "%.2f" % at, "-i", str(src), "-frames:v", "1",
        "-vf", ("scale=%d:%d:force_original_aspect_ratio=decrease"
                ":force_divisible_by=2" % (THUMB_EDGE, THUMB_EDGE)),
        "-q:v", "6",
        str(dest),
    ])


# --------------------------------------------------------------------------
# Én fil
# --------------------------------------------------------------------------

def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def title_from(path):
    """
    "01 Brudens tale.mov" -> "Brudens tale".  Nummeret foran er der kun for at
    holde rækkefølgen i mappen og hører ikke hjemme på siden.
    """
    stem = os.path.splitext(os.path.basename(path))[0]
    stem = re.sub(r"^[\s\-_0-9.]+", "", stem)
    stem = stem.replace("_", " ").replace("-", " ")
    stem = re.sub(r"\s+", " ", stem).strip()
    return stem[:120] or "Video fra brylluppet"


def taken_at(created, fallback_path):
    if created:
        text = created.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(text).astimezone(timezone.utc).isoformat()
        except ValueError:
            pass
    stamp = os.path.getmtime(fallback_path)
    return datetime.fromtimestamp(stamp, tz=timezone.utc).isoformat()


def handle(path, base, key, seen, dry_run, workdir):
    file_hash = digest(path)
    if file_hash in seen:
        return "skipped"
    seen.add(file_hash)

    info = probe(path)
    name = os.path.basename(path)
    print("    %s — %s, omkoder…" % (name, human_time(info["duration"])))

    video_id = str(uuid.uuid4())
    mp4 = os.path.join(workdir, video_id + ".mp4")
    jpg = os.path.join(workdir, video_id + "_t.jpg")

    started = time.time()
    transcode(path, mp4)
    poster(mp4, jpg, info["duration"])

    # Mål og længde læses fra den FÆRDIGE fil: skaleringen og rotationen er
    # først afgjort dér, og det er de tal, galleriet skal bruge.
    final = probe(mp4)
    size_mb = os.path.getsize(mp4) / (1024 * 1024)
    print("        %.0f MB på %d sek." % (size_mb, round(time.time() - started)))

    if dry_run:
        os.remove(mp4)
        os.remove(jpg)
        return "would-import"

    storage_path = "%s/%s.mp4" % (VIDEO_FOLDER, video_id)
    thumb_path = "%s/%s_t.jpg" % (VIDEO_FOLDER, video_id)

    with open(mp4, "rb") as fh:
        upload(base, key, storage_path, fh.read(), "video/mp4")
    with open(jpg, "rb") as fh:
        upload(base, key, thumb_path, fh.read(), "image/jpeg")

    os.remove(mp4)
    os.remove(jpg)

    row = {
        "id": video_id,
        "kind": "video",
        "source": "couple",
        "storage_path": storage_path,
        "thumb_path": thumb_path,
        # Ingen original: download giver netop den fil, folk ser.
        "original_path": None,
        "title": title_from(path),
        "duration_s": int(round(final["duration"])),
        "width": final["width"],
        "height": final["height"],
        "taken_at": taken_at(info["created"], path),
        "import_hash": file_hash,
    }
    status, body = request(
        "POST", "%s/rest/v1/photos" % base, key,
        data=json.dumps(row).encode(),
        headers={"Content-Type": "application/json", "Prefer": "return=minimal"},
    )
    if status == 400 and b"kind" in body:
        raise Fatal(
            "Kolonnen kind findes ikke endnu.\n"
            "Kør SQL-blokken i docs/supabase.md afsnit 4e først."
        )
    if status >= 300:
        raise Fatal("kunne ikke gemme %s: HTTP %s %s" % (name, status, body[:200]))
    return "imported"


def human_time(seconds):
    s = int(round(seconds))
    return "%d:%02d" % (s // 60, s % 60)


# --------------------------------------------------------------------------

def collect(folder):
    found = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in sorted(files):
            if name.startswith("."):
                continue
            if os.path.splitext(name)[1].lower() in SUFFIXES:
                found.append(os.path.join(root, name))
    return found


def main():
    ap = argparse.ArgumentParser(description="Importér talerne og underholdningen til galleriet.")
    ap.add_argument("folder", help="mappe med videoerne (undermapper tages med)")
    ap.add_argument("--dry-run", action="store_true", help="omkod, men læg intet op")
    ap.add_argument("--limit", type=int, help="stop efter så mange filer — god til en prøvetur")
    args = ap.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit("%s mangler.  brew install ffmpeg" % tool)

    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not base or not key:
        sys.exit("Sæt SUPABASE_URL og SUPABASE_SERVICE_KEY først. Se toppen af filen.")
    if not os.path.isdir(args.folder):
        sys.exit("Ikke en mappe: " + args.folder)

    files = collect(args.folder)
    if args.limit:
        files = files[:args.limit]
    if not files:
        sys.exit("Fandt ingen videoer i " + args.folder)

    print("Fandt %d videoer." % len(files))
    seen = existing_hashes(base, key)
    print("Allerede lagt op: %d." % len(seen))
    if args.dry_run:
        print("PRØVETUR — der lægges intet op.")

    counts = {"imported": 0, "skipped": 0, "would-import": 0, "failed": 0}
    started = time.time()

    # Én ad gangen: ffmpeg bruger alle kernerne i forvejen, og fire samtidige
    # omkodninger gør det hele langsommere, ikke hurtigere.
    workdir = tempfile.mkdtemp(prefix="wedvideo-")
    try:
        for i, path in enumerate(files, 1):
            print("  [%d/%d] %s" % (i, len(files), os.path.basename(path)))
            try:
                counts[handle(path, base, key, seen, args.dry_run, workdir)] += 1
            except Exception as e:
                counts["failed"] += 1
                print("    FEJL  %s" % e)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    print("\nFærdig på %d minutter." % round((time.time() - started) / 60))
    for name in ("imported", "skipped", "would-import", "failed"):
        if counts[name]:
            print("  %-13s %d" % (name, counts[name]))
    if counts["failed"]:
        print("\nKør den igen — de videoer, der kom igennem, springes over.")
        sys.exit(1)


if __name__ == "__main__":
    main()
