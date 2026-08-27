#!/usr/bin/env bash
#
# Læg en mappe med billeder op i galleriet under ét navn.
#
#     tools/upload.sh "/sti/til/mappen" "Navn i rullemenuen"
#
# Kræver, at nøglen er sat i den terminal, du kører den fra:
#
#     export SUPABASE_URL="https://bpyjzpxnqzjiwzzshscs.supabase.co"
#     export SUPABASE_SERVICE_KEY="..."      # service_role / secret
#
# Den kan afbrydes og køres igen: alt, der allerede er lagt op, springes over.

set -uo pipefail

FOLDER="${1:-}"
NAME="${2:-}"
# Spandens grænse i MB — skal svare til den, der står i Supabase under
# Storage -> gallery -> Edit bucket. Sæt LIMIT_MB=... foran kommandoen for at
# tjekke mod en anden værdi.
LIMIT_MB="${LIMIT_MB:-40}"

die() { printf '\n  FEJL: %s\n\n' "$1" >&2; exit 1; }

[ -n "$FOLDER" ] && [ -n "$NAME" ] || die "brug: tools/upload.sh \"/sti/til/mappe\" \"Navn\""
[ -d "$FOLDER" ] || die "mappen findes ikke: $FOLDER"
[ -n "${SUPABASE_URL:-}" ] || die "SUPABASE_URL er ikke sat i denne terminal."
[ -n "${SUPABASE_SERVICE_KEY:-}" ] || die "SUPABASE_SERVICE_KEY er ikke sat i denne terminal."

# --- Er nøglen den rigtige? -------------------------------------------------
# import_hash er lukket for den offentlige nøgle, så 200 her betyder, at vi
# kører med service_role og ikke med anon.
code=$(curl -s -o /dev/null -w "%{http_code}" \
  "$SUPABASE_URL/rest/v1/photos?select=import_hash&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY")
[ "$code" = "200" ] || die "nøglen duer ikke (HTTP $code). Det er nok den offentlige i stedet for service_role."

# --- Hvad ligger der, og passer det i spanden? ------------------------------
# Billedimporten lægger ORIGINALEN op ved siden af visningskopien, så det er
# den største fil, der afgør, om spandens grænse holder. Bliver den ramt,
# svarer Supabase 413 — efter at have hentet filen. Derfor tjekker vi først.
printf '\n  Mappe : %s\n  Navn  : %s\n\n' "$FOLDER" "$NAME"

find "$FOLDER" -type f -not -name '.*' \
  \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \
     -o -iname '*.tif' -o -iname '*.tiff' -o -iname '*.webp' \) \
  -exec stat -f%z {} \; | LIMIT_MB="$LIMIT_MB" python3 -c '
import sys, os
lim = int(os.environ["LIMIT_MB"]) * 1048576
s = sorted(int(x) for x in sys.stdin)
if not s:
    sys.exit("  Ingen billeder i mappen.")
mb = lambda b: b / 1048576
over = [x for x in s if x > lim]
print("  %d billeder, %.2f GB, største %.1f MB" % (len(s), sum(s)/1073741824, mb(s[-1])))
if over:
    print()
    print("  %d fil(er) er større end spandens grænse på %d MB." % (len(over), int(os.environ["LIMIT_MB"])))
    print("  De bliver AFVIST. Sæt grænsen op under Storage -> gallery -> Edit bucket")
    print("  (mindst %d MB), og kør så igen." % (int(mb(s[-1])) + 2))
    sys.exit(1)
print("  Alle filer er under grænsen på %d MB." % int(os.environ["LIMIT_MB"]))
' || die "stoppet, før der blev lagt noget op."

printf '\n  Går i gang. Kan afbrydes med Ctrl-C og startes igen.\n\n'
exec python3 "$(dirname "$0")/import_fotograf.py" "$FOLDER" --name "$NAME"
