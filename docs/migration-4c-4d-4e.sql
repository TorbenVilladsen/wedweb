-- Galleriets kolonner: 4c + 4d + 4e fra docs/supabase.md, samlet i én omgang.
--
-- Kør den i Supabase → SQL Editor → New query → Run.
--
-- Den kan køres flere gange uden skade: alt er "if not exists" eller
-- "drop ... if exists". Kører den halvvejs og stopper, så kør den bare igen.
--
-- Hvad den retter: siden spørger allerede efter de her kolonner. Findes de
-- ikke, svarer PostgREST 400 ("column photos.kind does not exist"), og
-- galleriet falder tilbage til de gamle kolonner. Det virker — men det koster
-- fire fejl i loggen for hver gæst, der åbner siden.
--
-- Hvad gæsterne mærker: ingenting. De 134 billeder, der ligger nu, får
-- source = 'guest' og kind = 'photo' automatisk. Video- og Fotograf-fanerne
-- bliver ved med at være skjulte, indtil der rent faktisk ligger noget.

begin;

-- ---------------------------------------------------------------------------
-- 4c. Hvor billedet kommer fra
-- ---------------------------------------------------------------------------
alter table public.photos
  add column if not exists source text not null default 'guest';

-- Galleriet henter altid nyeste først, og skal kunne gøre det for én kilde ad
-- gangen uden at læse hele tabellen igennem.
create index if not exists photos_source_seq_idx
  on public.photos (source, seq desc);

-- ---------------------------------------------------------------------------
-- 4d. Fotografens originaler
-- ---------------------------------------------------------------------------
alter table public.photos add column if not exists original_path text;

-- Gør importen idempotent: samme fil to gange giver samme sum, og så springes
-- den over. Det er det, der gør, at man kan afbryde importen af 5.000
-- billeder og bare starte den igen.
alter table public.photos add column if not exists import_hash text;
create unique index if not exists photos_import_hash_key
  on public.photos (import_hash) where import_hash is not null;

-- ---------------------------------------------------------------------------
-- 4e. Talerne og underholdningen
-- ---------------------------------------------------------------------------
alter table public.photos add column if not exists kind       text not null default 'photo';
alter table public.photos add column if not exists duration_s int;
alter table public.photos add column if not exists title      text;

alter table public.photos drop constraint if exists photos_kind_ok;
alter table public.photos add  constraint photos_kind_ok
  check (kind in ('photo', 'video'));

-- Jeres egne optagelser er hverken fotografens eller en gæsts.
alter table public.photos drop constraint if exists photos_source_ok;
alter table public.photos add  constraint photos_source_ok
  check (source in ('guest', 'photographer', 'couple'));

create index if not exists photos_kind_seq_idx
  on public.photos (kind, seq desc);

-- ---------------------------------------------------------------------------
-- Adgang: én grant, der dækker alt, browseren må læse.
--
-- import_hash står med vilje IKKE på listen — den skal ingen udefra kunne
-- læse. Og hverken source, kind, duration_s eller title kommer med i
-- grant insert (...) andre steder: alt, hvad en browser lægger op, er
-- automatisk et 'guest'-'photo', og ingen kan udgive deres eget billede for
-- at være fotografens eller en tale.
-- ---------------------------------------------------------------------------
grant select (id, seq, storage_path, thumb_path, guest_name, width, height,
              taken_at, created_at, approved, deleted_at, source, original_path,
              kind, duration_s, title)
  on public.photos to anon;

commit;

-- ---------------------------------------------------------------------------
-- Tjek bagefter: skal give én række med alle syv kolonner.
-- ---------------------------------------------------------------------------
-- select source, original_path, import_hash, kind, duration_s, title
--   from public.photos limit 1;
