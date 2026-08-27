#!/usr/bin/env python3
"""
Læg fotografens billeder ind i galleriet.

Kører fra jeres egen computer — ikke fra hjemmesiden. Hvert billede lægges op i
tre størrelser: en miniature til galleriet, en visningsudgave til når man
trykker på det, og originalen, som gæsterne får, hvis de downloader.

Den kan afbrydes og startes igen. Hver fil får en checksum, og filer, der
allerede er lagt op, springes over. Så koster en afbrudt import af 5.000
billeder ikke andet end tiden.

    export SUPABASE_URL="https://xxxx.supabase.co"
    export SUPABASE_SERVICE_KEY="ey..."        # service_role — ALDRIG i git
    python3 tools/import_fotograf.py ~/Billeder/bryllup --dry-run
    python3 tools/import_fotograf.py ~/Billeder/bryllup

Kræver Pillow:

    python3 -m venv .venv && .venv/bin/pip install Pillow
    .venv/bin/python tools/import_fotograf.py ...
"""

import argparse
import concurrent.futures
import hashlib
import io
import json
import mimetypes
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow mangler.  python3 -m venv .venv && .venv/bin/pip install Pillow")

# Skal matche CONFIG i photos.js, ellers dukker billederne ikke op i galleriet.
DAY_FOLDER = "uploads/2026-08-15"
ORIGINAL_FOLDER = DAY_FOLDER + "/original"
BUCKET = "gallery"

MAX_EDGE = 2560
JPEG_Q = 82
THUMB_EDGE = 480
THUMB_Q = 70

SUFFIXES = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
TIMEOUT = 180


class Fatal(Exception):
    pass


# --------------------------------------------------------------------------
# HTTP
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
            # Filnavnene er checksummer, så indholdet ændrer sig aldrig.
            "Cache-Control": "public, max-age=31536000, immutable",
            "x-upsert": "true",
        },
    )
    if status >= 300:
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
            raise Fatal("kunne ikke hente eksisterende billeder: HTTP %s %s" % (status, body[:200]))
        rows = json.loads(body)
        for r in rows:
            if r.get("import_hash"):
                seen.add(r["import_hash"])
        if len(rows) < step:
            return seen
        offset += step


# --------------------------------------------------------------------------
# Billedbehandling
# --------------------------------------------------------------------------

def taken_at(img, fallback_path):
    """
    EXIF DateTimeOriginal. Filens tidsstempel duer ikke: kopierer man 5.000
    billeder fra fotografens drev, får de alle sammen dagens dato, og så står
    hele galleriet i tilfældig rækkefølge.
    """
    try:
        exif = img.getexif()
        for tag in (36867, 36868, 306):          # DateTimeOriginal, Digitized, DateTime
            raw = exif.get(tag)
            if raw:
                parsed = datetime.strptime(str(raw).strip(), "%Y:%m:%d %H:%M:%S")
                return parsed.replace(tzinfo=timezone.utc).isoformat()
    except Exception:
        pass
    stamp = os.path.getmtime(fallback_path)
    return datetime.fromtimestamp(stamp, tz=timezone.utc).isoformat()


def encode(img, max_edge, quality):
    copy = img.copy()
    copy.thumbnail((max_edge, max_edge), Image.LANCZOS)
    if copy.mode not in ("RGB", "L"):
        copy = copy.convert("RGB")
    buf = io.BytesIO()
    copy.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue(), copy.width, copy.height


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------
# Én fil
# --------------------------------------------------------------------------

def handle(path, base, key, seen, lock, dry_run, name=None, source="photographer"):
    file_hash = digest(path)
    with lock:
        if file_hash in seen:
            return "skipped"
        seen.add(file_hash)

    with Image.open(path) as raw:
        # Vender billedet efter EXIF, så portrætbilleder ikke ligger ned.
        img = ImageOps.exif_transpose(raw)
        shot = taken_at(raw, path)
        display, width, height = encode(img, MAX_EDGE, JPEG_Q)
        thumb, _, _ = encode(img, THUMB_EDGE, THUMB_Q)

    if dry_run:
        return "would-import"

    photo_id = str(uuid.uuid4())
    ext = os.path.splitext(path)[1].lower() or ".jpg"
    display_path = "%s/%s.jpg" % (DAY_FOLDER, photo_id)
    thumb_path = "%s/%s_t.jpg" % (DAY_FOLDER, photo_id)
    original_path = "%s/%s%s" % (ORIGINAL_FOLDER, photo_id, ext)

    upload(base, key, display_path, display, "image/jpeg")
    upload(base, key, thumb_path, thumb, "image/jpeg")
    with open(path, "rb") as fh:
        upload(base, key, original_path, fh.read(),
               mimetypes.guess_type(path)[0] or "application/octet-stream")

    row = {
        "id": photo_id,
        "storage_path": display_path,
        "thumb_path": thumb_path,
        "original_path": original_path,
        "guest_name": name,
        "width": width,
        "height": height,
        "taken_at": shot,
        "source": source,
        "import_hash": file_hash,
    }
    status, body = request(
        "POST", "%s/rest/v1/photos" % base, key,
        data=json.dumps(row).encode(),
        headers={"Content-Type": "application/json", "Prefer": "return=minimal"},
    )
    if status >= 300:
        raise Fatal("kunne ikke gemme %s: HTTP %s %s" % (os.path.basename(path), status, body[:200]))
    return "imported"


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
    ap = argparse.ArgumentParser(description="Importér fotografens billeder til galleriet.")
    ap.add_argument("folder", help="mappe med billederne (undermapper tages med)")
    ap.add_argument("--dry-run", action="store_true", help="behandl billederne, men læg intet op")
    ap.add_argument("--workers", type=int, default=4, help="hvor mange ad gangen (standard 4)")
    ap.add_argument("--limit", type=int, help="stop efter så mange filer — god til en prøvetur")
    ap.add_argument("--name", metavar="NAVN",
                    help="navnet, billederne skal stå under i galleriets rullemenu, "
                         "fx \"Fotografen\" eller \"Mormors kamera\". Uden den står de "
                         "uden navn og kan kun findes under fanen Fotografen.")
    ap.add_argument("--source", choices=("photographer", "guest", "couple"),
                    default="photographer",
                    help="hvilken fane billederne hører til (standard: photographer)")
    args = ap.parse_args()

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
        sys.exit("Fandt ingen billeder i " + args.folder)

    print("Fandt %d billeder." % len(files))
    print("Navn i rullemenuen: %s" % (args.name or "(intet — kun under fanen Fotografen)"))
    seen = existing_hashes(base, key)
    print("Allerede lagt op: %d." % len(seen))

    lock = threading.Lock()
    counts = {"imported": 0, "skipped": 0, "would-import": 0, "failed": 0}
    started = time.time()

    def work(path):
        try:
            return path, handle(path, base, key, seen, lock, args.dry_run,
                                args.name, args.source), None
        except Exception as e:
            return path, "failed", e

    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for path, result, err in pool.map(work, files):
            done += 1
            counts[result] += 1
            if err:
                print("  FEJL  %s — %s" % (os.path.basename(path), err))
            if done % 25 == 0 or done == len(files):
                rate = done / max(time.time() - started, 0.001)
                left = (len(files) - done) / max(rate, 0.001)
                print("  %d/%d  (%.1f/sek, ca. %d min tilbage)"
                      % (done, len(files), rate, round(left / 60)))

    print("\nFærdig på %d minutter." % round((time.time() - started) / 60))
    for name in ("imported", "skipped", "would-import", "failed"):
        if counts[name]:
            print("  %-13s %d" % (name, counts[name]))
    if counts["failed"]:
        print("\nKør den igen — de billeder, der kom igennem, springes over.")
        sys.exit(1)


if __name__ == "__main__":
    main()
