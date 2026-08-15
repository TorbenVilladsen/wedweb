# Billedupload — opsætning og drift

Gæsterne åbner **Galleri**-siden via deres eget invitationslink og sender billeder
direkte fra telefonen. Billederne ligger hos **Supabase**, og galleriet henter dem
derfra.

Der er ingen åben side og ingen fælles QR-kode: upload kræver et gyldigt `?uid=`,
præcis som resten af siden. Gæster uden invitation — kærester, børn og andre — kan
altså ikke selv sende billeder, men kan låne en telefon af en, der er inviteret.

Der er ingen server i dette projekt — siden er ren HTML på GitHub Pages. Derfor
taler browseren direkte med Supabase, og alt sikkerhed ligger i de regler
(policies), du sætter op nedenfor.

---

## 1. Opret projektet

1. Gå til [supabase.com](https://supabase.com) → **Start your project** → log ind med GitHub.
2. **New project**.
   - Name: `wedweb-billeder`
   - **Database Password**: tryk *Generate* og **gem den i din adgangskodemanager**.
     Du får den aldrig at se igen. Du skal næsten aldrig bruge den.
   - **Region**: `Central EU (Frankfurt)` — den tættest på Danmark, så upload går hurtigst.
   - **Plan**: Free indtil videre.
3. Tryk **Create new project** og vent ca. 2 minutter.

---

## 2. Opret "spanden" til billederne

1. Menuen til venstre → **Storage** → **New bucket**.
2. Name: **`gallery`** — præcis sådan, med småt. Navnet står i koden.
3. Slå **Public bucket** til. (Det er det, der gør, at billederne kan vises på siden
   uden login.)
4. Fold **Additional configuration** ud:
   - **Restrict file size**: slå til, sæt til **10 MB**.
   - **Allowed MIME types**: skriv **`image/jpeg`** — og intet andet.
5. **Save**.

Punkt 4 er vigtigt: kontrollen i browseren kan omgås af enhver, der kigger i
sidens kildekode. Den her kan ikke.

---

## 3. Giv lov til upload — og kun det

1. **Storage** → **Policies** → find tabellen `objects` → **New policy** →
   **For full customization**.
2. Policy name: `anon can upload to gallery`
3. **Allowed operation**: sæt kun flueben ved **INSERT**.
4. **Target roles**: vælg **anon**.
5. I feltet **WITH CHECK expression**, indsæt præcis dette:

   ```sql
   bucket_id = 'gallery' AND name LIKE 'uploads/%' AND name LIKE '%.jpg'
   ```

6. **Review** → **Save policy**.

**Opret ingen andre policies på `objects`.** Det er med vilje, og det giver:

| Der er ingen…  | …og derfor kan ingen |
|---|---|
| UPDATE-policy | overskrive et billede, der allerede er sendt |
| DELETE-policy | slette billeder |
| SELECT-policy | få en liste over, hvad der ligger i spanden |

Billederne kan stadig **vises**, fordi spanden er public — man skal bare kende den
præcise adresse, og adresserne er tilfældige UUID'er.

---

## 4. Opret tabellen med oplysninger om billederne

**SQL Editor** → **New query** → indsæt det hele → **Run**.

```sql
create table if not exists public.photos (
  id           uuid primary key default gen_random_uuid(),
  seq          bigint generated always as identity,
  storage_path text not null unique,
  thumb_path   text not null,
  guest_name   text,
  width        int,
  height       int,
  taken_at     timestamptz,
  created_at   timestamptz not null default now(),
  approved     boolean not null default true,
  constraint photos_path_ok  check (storage_path like 'uploads/%'),
  constraint photos_thumb_ok check (thumb_path   like 'uploads/%'),
  constraint photos_name_len check (guest_name is null or char_length(guest_name) <= 60)
);

create index if not exists photos_seq_desc_idx on public.photos (seq desc);

alter table public.photos enable row level security;

create policy "anyone can read approved photos"
  on public.photos for select to anon
  using (approved);

create policy "anyone can add a photo"
  on public.photos for insert to anon
  with check (approved = true);

revoke update, delete on public.photos from anon, authenticated;
```

Kort om hvorfor:

- `seq` bruges til at hente galleriet i sider. Uden den ville billeder blive vist
  dobbelt eller springes over, mens gæsterne uploader midt i det hele.
- `approved` er en skjul-knap, du kan slå fra og til uden at slette noget.
- `revoke`-linjen er en ekstra spærre: to uafhængige ting skal fejle, før nogen
  kan slette noget.

---

## 4b. Sletning og admin-login

Kør hele blokken i **SQL Editor** → **New query** → **Run**.

```sql
-- Gæster kan skjule deres egne billeder; I kan slette alt.

alter table public.photos add column if not exists delete_token text;
alter table public.photos add column if not exists deleted_at  timestamptz;

-- Gæster må ALDRIG kunne læse delete_token — så kunne enhver slette alt.
-- Derfor kolonne-for-kolonne adgang i stedet for adgang til hele tabellen.
revoke select, insert, update, delete on public.photos from anon;

grant select (id, seq, storage_path, thumb_path, guest_name,
              width, height, taken_at, created_at, approved, deleted_at)
  on public.photos to anon;

grant insert (id, storage_path, thumb_path, guest_name,
              width, height, taken_at, delete_token)
  on public.photos to anon;

-- I selv, når I er logget ind, må se og slette alt.
grant select, delete on public.photos to authenticated;

drop policy if exists "anyone can read approved photos" on public.photos;

create policy "anyone can read visible photos"
  on public.photos for select to anon
  using (approved and deleted_at is null);

create policy "signed in can read every photo"
  on public.photos for select to authenticated
  using (true);

create policy "signed in can delete photos"
  on public.photos for delete to authenticated
  using (true);

-- Gæstens egen sletning. Funktionen kører med forhøjede rettigheder, men
-- gør kun noget, hvis den hemmelige nøgle fra gæstens telefon passer.
create or replace function public.delete_own_photo(p_id uuid, p_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.photos
     set deleted_at = now()
   where id = p_id
     and deleted_at is null
     and delete_token is not null
     and delete_token = p_token;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.delete_own_photo(uuid, text) from public;
grant execute on function public.delete_own_photo(uuid, text) to anon, authenticated;
```

### Lad jer selv slette filerne

**Storage → Policies → `objects` → New policy → For full customization**

- Policy name: `signed in can delete gallery files`
- **Allowed operation**: kun **DELETE**
- **Target roles**: **authenticated**
- **USING expression**:
  ```sql
  bucket_id = 'gallery'
  ```

### Opret jeres eget login

1. **Authentication** → **Users** → **Add user** → **Create new user**.
2. Skriv jeres e-mail og en adgangskode. Sæt flueben i **Auto Confirm User**.
3. Gem adgangskoden i din adgangskodemanager.

> **Vigtigt:** gå derefter til **Authentication** → **Providers** → **Email** og
> slå **Enable sign ups** FRA.
>
> Alle, der er logget ind, kan slette alt. Hvis fremmede selv kan oprette en
> bruger, kan de også slette jeres billeder. Med tilmelding slået fra findes
> der kun den ene bruger, I lige har oprettet.

Log ind på **anne-og-torben.dk/admin**. Siden er ikke linket fra resten af
sitet, men det er login'et — ikke den skjulte adresse — der beskytter den.

### Hvad "slet" betyder de to steder

| Hvem | Hvad sker der | Kan det fortrydes |
|---|---|---|
| Gæst sletter sit eget | Billedet forsvinder fra galleriet for alle. Filen bliver liggende. | Ja — sæt `deleted_at` til `null` i Table Editor |
| I sletter (logget ind) | Række og begge filer slettes permanent. | Nej |

En gæst kan kun slette fra **den telefon, billedet blev sendt fra**. Nøglen
ligger i browserens hukommelse på den enhed. Rydder de browserdata eller
skifter telefon, må de spørge jer. Det er prisen for, at gæsterne slipper for
at oprette en bruger.

Sæt flueben i **"Vis også billeder, gæster har slettet"** på admin-siden for at
se dem, gæsterne har fjernet, og rydde filerne op bagefter.

---

## 4c. Hvor billedet kommer fra (`source`)

**Kør denne blok, før I lægger fotografens billeder ind.** Bagefter kan man ikke
længere se, hvad der kom fra hvem — og med 3.000–5.000 billeder fra fotografen
drukner gæsternes egne billeder, hvis de ikke kan skilles ad.

```sql
alter table public.photos
  add column if not exists source text not null default 'guest';

alter table public.photos
  drop constraint if exists photos_source_ok;
alter table public.photos
  add constraint photos_source_ok check (source in ('guest', 'photographer'));

-- Galleriet henter altid nyeste først, og skal kunne gøre det for én kilde ad
-- gangen uden at læse hele tabellen igennem.
create index if not exists photos_source_seq_idx
  on public.photos (source, seq desc);

-- Gæsterne må gerne SE hvor et billede kommer fra …
grant select (id, seq, storage_path, thumb_path, guest_name,
              width, height, taken_at, created_at, approved, deleted_at, source)
  on public.photos to anon;
```

Læg mærke til, at `source` **ikke** kommer med i `grant insert (...)`. Det er
med vilje: alt, der uploades fra browseren, får automatisk `'guest'`, og ingen
kan udgive deres eget billede for at være fotografens. Kun importen — som kører
med `service_role`-nøglen fra jeres egen computer — sætter `'photographer'`.

Eksisterende billeder får `'guest'`, hvilket er det rigtige: alt, der ligger der
nu, er sendt fra en browser.

---

## 4d. Fotografens originaler

Fotografens billeder lægges op i **tre** størrelser:

| Fil | Størrelse | Bruges til |
|---|---|---|
| miniature | 480 px, ca. 40 KB | galleriets små felter |
| visning | 2560 px, ca. 700 KB | når man trykker på et billede |
| original | som fotografen leverede den | knappen **Download** |

Gæsterne henter altså ikke 15 MB, hver gang de kigger på et billede — men det er
originalen, de får, hvis de downloader den. Kør denne blok sammen med 4c:

```sql
-- Stien til originalen. Tom for gæsternes egne billeder: der ER ingen original
-- ud over den, browseren allerede har skaleret ned.
alter table public.photos add column if not exists original_path text;

-- Gør importen idempotent: samme fil to gange giver samme sum, og så springes
-- den over i stedet for at blive lagt ind igen. Det er det, der gør, at man kan
-- afbryde importen af 5.000 billeder og bare starte den igen.
alter table public.photos add column if not exists import_hash text;
create unique index if not exists photos_import_hash_key
  on public.photos (import_hash) where import_hash is not null;

grant select (id, seq, storage_path, thumb_path, guest_name,
              width, height, taken_at, created_at, approved, deleted_at,
              source, original_path)
  on public.photos to anon;
```

`import_hash` bliver med vilje **ikke** delt ud til `anon` — den skal ingen
udefra kunne læse, og `original_path` er den eneste nye kolonne, browseren har
brug for.

> **Kør 4c og 4d, før I henter siden ned igen.** Galleriet spørger efter de nye
> kolonner. Det klarer sig, hvis de mangler (så mister man bare download af
> originalen), men kør dem nu, så I ikke skal huske det senere.

### Sådan lægger I fotografens billeder ind

Fotografens 3.000–5.000 billeder skal **ikke** sendes gennem hjemmesiden. En
browserfane, der arbejder i to timer uden at kunne fortsætte, hvis den lukkes,
er den forkerte måde. Brug i stedet scriptet, der ligger i projektet.

Første gang — hent Pillow, som scriptet bruger til at skalere billederne:

```bash
cd ~/weddingWebsiteReworked/wedweb
python3 -m venv .venv
.venv/bin/pip install Pillow
```

Hent så **service_role**-nøglen: **Project Settings → API → service_role**.

> Den nøgle kan alt: læse, ændre og slette alt i projektet. Den må **aldrig**
> ligge i koden, i git eller på hjemmesiden. Den skrives kun ind i terminalen,
> som her, og forsvinder, når vinduet lukkes.

```bash
export SUPABASE_URL="https://bpyjzpxnqzjiwzzshscs.supabase.co"
export SUPABASE_SERVICE_KEY="ey…"      # service_role, ikke anon
```

Kør en prøvetur på 20 billeder først — den behandler dem, men lægger intet op:

```bash
.venv/bin/python tools/import_fotograf.py ~/Billeder/bryllup --limit 20 --dry-run
```

Ser det rigtigt ud, så kør resten:

```bash
.venv/bin/python tools/import_fotograf.py ~/Billeder/bryllup
```

Scriptet:

- går også undermapper igennem og springer alt, der ikke er et billede, over
- læser **optagetidspunktet** i billedets EXIF, så rækkefølgen bliver rigtig
  (filens dato duer ikke — kopierer man 5.000 filer, får de alle dagens dato)
- vender portrætbilleder rigtigt
- lægger tre filer op pr. billede: miniature, visning og originalen
- markerer dem som `source = 'photographer'`
- **kan afbrydes.** Tryk Ctrl-C, luk computeren, kør den igen i morgen — den
  springer over alt, der allerede er kommet op. Samme mappe to gange giver
  altså ikke dobbelte billeder.

Går noget galt undervejs, skriver den hvilke filer det gik ud over og slutter
med at bede dig køre den igen. Det er sikkert at gøre.

---

## 4e. Talerne og underholdningen (video)

**Kør først dette, når I skal lægge videoerne op** — altså efter brylluppet.
Galleriet fungerer uændret uden.

De ti videoer fra dagen er noget andet end gæsternes billeder: det er en
håndfuld filer, I selv lægger op fra jeres computer, og som I kan omkode
ordentligt først. Det er derfor de kan lade sig gøre, mens video fra gæsternes
telefoner stadig ikke kan (afsnit 7bb).

### En spand for sig

Videoerne må **ikke** i `gallery`. Den spand er spærret til 10 MB og
`image/jpeg`, og det er den eneste grænse for gæsternes upload, som en browser
ikke kan snakke sig uden om: policyen fra afsnit 3 kræver ganske vist, at
filnavnet ender på `.jpg`, men den siger intet om størrelsen. Sætter I grænsen
op, så en video kan være der, kan enhver, der kigger i sidens kildekode, også
lægge en 2 GB stor fil op, der hedder `.jpg`.

**Storage** → **New bucket**:

- Name: **`video`** — præcis sådan, med småt. Navnet står i koden.
- **Public bucket**: til.
- **Restrict file size**: **2 GB**.
- **Allowed MIME types**: `video/mp4` og `image/jpeg` (still-billederne til
  gitteret ligger samme sted).

**Opret ingen policies på den spand.** Uden policies kan `anon` — altså alle,
der besøger siden — hverken lægge op, ændre eller slette. Kun importen, der
kører med `service_role`-nøglen fra jeres egen computer, kan skrive der.
Nødbremsen er den samme som for billederne: sæt spanden til ikke-public, så er
videoerne væk fra siden med det samme.

### Kolonnerne

**SQL Editor** → **New query** → **Run**.

```sql
alter table public.photos add column if not exists kind        text not null default 'photo';
alter table public.photos add column if not exists duration_s  int;
alter table public.photos add column if not exists title       text;

alter table public.photos drop constraint if exists photos_kind_ok;
alter table public.photos add  constraint photos_kind_ok check (kind in ('photo','video'));

-- Jeres egne optagelser er hverken fotografens eller en gæsts.
alter table public.photos drop constraint if exists photos_source_ok;
alter table public.photos add  constraint photos_source_ok
  check (source in ('guest','photographer','couple'));

create index if not exists photos_kind_seq_idx on public.photos (kind, seq desc);

grant select (id, seq, storage_path, thumb_path, guest_name, width, height,
              taken_at, created_at, approved, deleted_at, source, original_path,
              kind, duration_s, title)
  on public.photos to anon;
```

Læg mærke til, at `kind`, `duration_s` og `title` **ikke** kommer med i
`grant insert (...)` — samme grund som `source` i afsnit 4c. Alt, hvad en
browser lægger op, er automatisk et `'photo'`, og ingen kan udgive deres eget
billede for at være en tale.

Siden klarer sig, hvis I glemmer blokken: så viser galleriet bare billeder,
præcis som før. Den går ikke i stykker.

---

## 5. Sæt de to værdier ind i koden

1. Tandhjulet **Project Settings** → **API** (kan hedde **API Keys**).
2. Kopiér **Project URL** — ser ud som `https://abcdefghijklm.supabase.co`.
3. Kopiér **anon / public**-nøglen — en meget lang tekst.
   *(Nyere projekter viser i stedet en nøgle, der starter med `sb_publishable_`.
   Den virker på præcis samme måde her.)*
4. Åbn `photos.js` i roden af projektet og udfyld de to felter øverst:

   ```js
   const CONFIG = {
       SUPABASE_URL: "https://DIT-PROJEKT.supabase.co",
       SUPABASE_ANON_KEY: "DIN_ANON_KEY_HER",
       ...
   ```

5. Commit og push til `main`. GitHub Pages lægger ændringen ud automatisk.

### Er det ikke farligt at lægge nøglen på en offentlig side?

Nej. `anon`-nøglen er ikke en hemmelighed — den siger bare "denne forespørgsel
hører til projekt X". Alle Supabase-sider har den liggende i kildekoden.
Sikkerheden ligger i reglerne fra punkt 3 og 4. Med dem kan nøglen præcis tre ting:

- lægge et JPEG på højst 10 MB ind under `uploads/`
- gemme en række i `photos`, der peger på `uploads/`
- læse de rækker, hvor `approved` er sand

Ikke slette, ikke ændre, ikke se andre tabeller.

**Det, der reelt er en risiko:** enhver, der kigger i sidens kildekode, kan sende
et vilkårligt JPEG ind, som så dukker op i galleriet. Det kan ikke undgås uden en
server. Se nødbremsen nedenfor.

---

## 6. Før brylluppet — vigtigt

**Gratis Supabase-projekter sættes på pause efter ca. 7 dages inaktivitet.**
Hvis siden bygges i god tid og ingen rører den, er billedsiden død på selve dagen.

- **Opgradér til Pro (ca. $25/md.) senest en uge før 15. august 2026.**
  Pro-projekter sættes aldrig på pause, og du får plads nok til billederne.
- Slå **spend cap** til under Settings → Billing. Så kan der ikke komme en
  overraskelsesregning; tjenesten sætter farten ned i stedet.
- Du kan nedgradere igen efter brylluppet.
- Indtil du opgraderer: åbn siden eller dashboardet et par gange om ugen, så
  projektet ikke går i pause undervejs.

---

## 7. Hvis noget går galt på dagen

### Nødbremse — stop alle uploads med det samme

**Storage → Policies → `objects` → slet policyen `anon can upload to gallery`.**

Upload stopper på ca. 20 sekunder, og du kan gøre det fra en telefon. Der skal
ikke deployes noget. Opret policyen igen (punkt 3) for at åbne igen.

Skal galleriet også slukkes helt: sæt spanden `gallery` til ikke-public.

### Fjern ét billede

Nemmest: log ind på **anne-og-torben.dk/admin**, åbn billedet og tryk
**Slet permanent**. Det fjerner både rækken og begge filer.

Hvis I hellere vil gøre det i dashboardet:

- **Skjul midlertidigt (kan fortrydes):** Table Editor → `photos` → sæt
  `approved` til `false`. Billedet forsvinder fra galleriet; filen bliver liggende.
- **Slet permanent:** Storage → `gallery` → `uploads/2026-08-15/` → sæt flueben
  ved filen **og** dens miniature (samme navn med `_t` til sidst) → **Delete**.
  Slet derefter rækken i Table Editor.

Du finder det rigtige billede ved at højreklikke på det i galleriet →
*Kopiér billedadresse*. Adressen indeholder et UUID, som du kan søge efter i
Table Editor.

---

## 7b. Siden åbner først på dagen

`/Galleri/` er lukket indtil **15. august 2026 kl. 13.00** — altså præcis når
nedtællingen på forsiden rammer nul. Indtil da får gæsterne en pæn besked i
stedet for upload-knappen, og galleriet er skjult. Selve nedtællingen står kun
på forsiden; den gentages ikke her. Klokkeslættet står ét sted i koden:

```js
// photos.js
OPENS_AT: "August 15, 2026 13:00:00",
```

Skal tidspunktet flyttes, skal det **også** flyttes i `script.js` (linje 4),
ellers siger forsiden "Det er vores bryllup!", mens billedsiden stadig siger
"vi åbner senere".

`/admin/` er ikke omfattet — der kan I komme ind når som helst.

### Sådan tester I det før dagen

Åbn denne adresse **én gang** på den telefon, I vil teste med — brug jeres eget
`?uid=` fra invitationen:

```
https://anne-og-torben.dk/Galleri/?uid=JERES-UID&forhaandsvisning=1
```

Så husker netop den telefon indstillingen, og I kan køre hele forløbet igennem,
selvom der er dage til brylluppet. Gæsternes telefoner er ikke berørt — de har
aldrig set adressen.

Slå det fra igen med:

```
https://anne-og-torben.dk/Galleri/?uid=JERES-UID&forhaandsvisning=0
```

> Husk at slå det fra på jeres egne telefoner, når I er færdige med at teste —
> ellers opdager I ikke, hvis låsen driller for gæsterne.

---

## 7bb. Gæsterne kan kun sende billeder

Gæsterne kan kun sende **billeder** fra siden. En video kan ikke skaleres ned i
browseren, sådan som et billede kan, så den ville blive sendt i fuld størrelse
(en video på 30 sekunder fra en iPhone fylder 65–175 MB) — og en iPhone-video
kan oven i købet være uafspillelig på en Android-telefon. Derfor er video holdt
ude af upload'en med vilje.

> Det gælder **gæsternes upload**. Jeres egne optagelser — talerne og
> underholdningen — kan godt komme i galleriet; I lægger dem bare op fra
> computeren i stedet, hvor de kan omkodes ordentligt først. Se afsnit 7bd.

Under upload-knappen står der i stedet:

> Har I videoer? Send dem til os med WeTransfer — video kan ikke sendes her på siden.

med en lille foldbar vejledning. Linjen vises **kun**, når siden er åbnet — før
den tid er hele upload-delen erstattet af "vi åbner på dagen".

Mailadressen står ét sted i koden:

```js
// photos.js
VIDEO_EMAIL: "torben-v@hotmail.com",
```

> **Husk:** et gratis WeTransfer-link holder kun et par dage. Hent videoerne ned
> med det samme, I får mailen — ellers er de væk.

---

## 7bd. Sådan lægger I talerne og underholdningen op

Kør afsnit 4e først — både spanden og SQL'en.

Videoerne får deres egen fane **Video** i galleriet ved siden af *Alle*,
*Fotografen* og *Gæsterne*. Fanen dukker først op, når der ligger mindst én
video; ti videoer blandt fotografens tusinder ville ellers være væk fra
forsiden af galleriet inden for et minuts scrollen.

### Navngiv filerne først

Filnavnet bliver videoens titel på siden. Nummeret foran ryger væk — det er kun
til at holde rækkefølgen i mappen:

```
01 Brudens tale.mov        ->  "Brudens tale"
02 Gommens tale.mov        ->  "Gommens tale"
03 Sang fra bordet 4.mp4   ->  "Sang fra bordet 4"
```

### Kør importen

```bash
brew install ffmpeg
```

```bash
export SUPABASE_URL="https://bpyjzpxnqzjiwzzshscs.supabase.co"
export SUPABASE_SERVICE_KEY="ey…"      # service_role, ikke anon
```

Tag én video først, og se den på en telefon, før I kører resten:

```bash
python3 tools/import_video.py ~/Film/bryllup --limit 1
```

```bash
python3 tools/import_video.py ~/Film/bryllup
```

Scriptet omkoder hver video til H.264/AAC i en MP4 — den ene kombination, som
alle telefoner og computere kan afspille — skalerer den ned til 1080p, tager et
still-billede til gitteret og lægger begge dele op. Den kan afbrydes og startes
igen ligesom billedimporten.

### Det, der koster penge, er trafikken — ikke pladsen

To timers video fylder omkring 3,5 GB. Det er ingenting på Pro. Men **hver gang
en gæst ser en tale, sendes filen igen**, og taler er lige præcis det, familien
ser fra ende til anden. Ser 50 gæster en time hver, er det ~90 GB oven i
billederne.

Pro har en mængde trafik med i prisen, og med **spend cap slået til bliver
galleriet bremset i stedet for at koste ekstra**. Derfor:

- Videoen hentes **ikke**, før nogen trykker play — heller ikke når man åbner
  den. Scroller man forbi, bruges der ingenting.
- **Download** giver den samme MP4, folk ser (~300–400 MB), ikke råfilen fra
  kameraet på flere GB.
- **Kig på Reports → Usage et par dage efter, I har sendt linket ud.** Ser
  trafikken ud til at nå grænsen, er valget enten at hæve spend cap midlertidigt
  (vi taler småpenge i overforbrug) eller at sætte `video`-spanden til
  ikke-public, til måneden skifter. Det er bedre at vide det end at opdage det,
  fordi galleriet er gået i stå.

### Fjern én video

Log ind på **anne-og-torben.dk/admin**, åbn videoen og tryk **Slet permanent** —
præcis som med et billede. Både filen og still-billedet ryger.

---

## 7c. Testsiden

`/test/` er en kopi af billedsiden, som I kan bruge til at prøve det hele af på
forskellige telefoner. Den adskiller sig på tre punkter:

- **Ingen lås.** Den virker allerede nu, uden `?forhaandsvisning=`.
- **Ingen invitation.** Der skal ikke `?uid=` på. I kan sende adressen til en
  ven med en Android-telefon og bede dem prøve.
- **Egen mappe.** Billederne havner i `uploads/test/` i stedet for
  `uploads/2026-08-15/`, og de kan **ikke** ses i det rigtige galleri.

```
https://anne-og-torben.dk/test/
```

Øverst på siden står der, hvilken browser og skærm telefonen har, og om de tre
ting, upload'en bygger på, er til stede. Det er dem, I skal kigge på, hvis en
telefon driller — især **"Kan afkode billeder"**, som er den, der kan sige nej
på en Android-telefon med HEIC-billeder.

### Ryd op bagefter

Testbillederne ligger i samme tabel som de rigtige, så `/admin/` viser dem.
Log ind i `/admin/`, slet dem der, og slet til sidst hele `test`-mappen fra
projektet, når I ikke skal bruge den mere.

> Så længe `/test/` ligger på siden, kan enhver, der kender adressen, sende
> billeder til `uploads/test/`. Det er derfor, den skal væk igen — og derfor
> den ikke deler mappe med de rigtige billeder.

---

## 8. Tjekliste før dagen

Kør den ca. 2 uger før — og igen 2 dage før.

- [ ] Rigtig iPhone, via et rigtigt invitationslink: vælg 10 billeder → alle kommer
      frem, vender rigtigt og står i rigtig rækkefølge.
- [ ] Rigtig Android-telefon med **HEIF/"høj effektivitet"** slået til. Det er den
      eneste måde at afklare, om Android kan sende de billeder.
- [ ] Flytilstand midt i en upload → fejlbesked → slå net til igen → den fortsætter selv.
- [ ] Send 40 billeder på én gang fra en ældre telefon — holder browseren?
- [ ] Prøv at slette noget fra browserens konsol med anon-nøglen → skal give 403.
- [ ] Prøv at sende en `.png` og en fil på 20 MB → skal afvises.
- [ ] Galleriet på både mobil og computer: scroll forbi 3 sider, åbn et billede, swipe.
- [ ] Åbn `/Galleri/` **uden** `?uid=` → skal give "Adgang nægtet".
- [ ] Projektet er på **Pro** og ikke på pause. Der er plads nok.
- [ ] Åbn `/Galleri/?uid=…` på en telefon, der **ikke** er sat til forhåndsvisning →
      der skal stå "Vi åbner for billeder på selve dagen", og galleriet skal være skjult.
- [ ] Slå forhåndsvisning fra igen på jeres egne telefoner
      (`&forhaandsvisning=0`), når I er færdige med at teste.
- [ ] Slet testbillederne i `/admin/`, og fjern mappen `test/` fra projektet,
      når I er færdige med at teste på telefonerne.
