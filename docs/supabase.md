# Billedupload — opsætning og drift

Gæsterne scanner QR-koden på bordet, lander på **anne-og-torben.dk/fest** og sender
billeder direkte fra telefonen. Billederne ligger hos **Supabase**, og galleriet
henter dem derfra.

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
Hvis siden bygges i god tid og ingen rører den, er QR-koden død på selve dagen.

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

### Skjul ét billede (kan fortrydes)

**Table Editor** → `photos` → find rækken → sæt `approved` til `false` → gem.
Billedet forsvinder fra galleriet, næste gang siden hentes. Filen bliver liggende.

### Slet ét billede permanent

1. **Storage** → `gallery` → `uploads/2026-08-15/` → sæt flueben ved filen
   **og** dens miniature (samme navn med `_t` til sidst) → **Delete**.
2. **Table Editor** → `photos` → slet rækken.

Du finder det rigtige billede ved at højreklikke på det i galleriet →
*Kopiér billedadresse*. Adressen indeholder et UUID, som du kan søge efter i
Table Editor.

---

## 8. Tjekliste før dagen

Kør den ca. 2 uger før — og igen 2 dage før.

- [ ] Rigtig iPhone, via den **printede** QR-kode: vælg 10 billeder → alle kommer
      frem, vender rigtigt og står i rigtig rækkefølge.
- [ ] Rigtig Android-telefon med **HEIF/"høj effektivitet"** slået til. Det er den
      eneste måde at afklare, om Android kan sende de billeder.
- [ ] Flytilstand midt i en upload → fejlbesked → slå net til igen → den fortsætter selv.
- [ ] Send 40 billeder på én gang fra en ældre telefon — holder browseren?
- [ ] Prøv at slette noget fra browserens konsol med anon-nøglen → skal give 403.
- [ ] Prøv at sende en `.png` og en fil på 20 MB → skal afvises.
- [ ] Galleriet på både mobil og computer: scroll forbi 3 sider, åbn et billede, swipe.
- [ ] Åbn `/fest/` uden `?uid=` og tryk på alle menupunkter → ingen "Adgang nægtet".
- [ ] Det **printede** kort kan scannes fra ca. 40 cm i dæmpet, varmt restaurantlys.
- [ ] Projektet er på **Pro** og ikke på pause. Der er plads nok.
