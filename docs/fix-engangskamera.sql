-- Engangskamera-billederne: ret navnet, og flyt dem væk fra fotografen.

begin;

-- 1. Navnet. Galleriet skriver "Billede fra <navn>" og rullemenuen har i
--    forvejen overskriften "Billeder fra", så ordene stod to gange begge
--    steder. Uden "Billeder fra" foran læser begge rigtigt:
--        billedet      -> "Billede fra Engangskamera"
--        rullemenuen   -> "Billeder fra  ->  Engangskamera (219)"
update public.photos
   set guest_name = 'Engangskamera'
 where guest_name = 'Billeder fra engangskamera';

-- 2. Kilden. De blev lagt op som 'photographer', hvilket tænder fanen
--    "Fotografen" — men det er gæsternes engangskamera, ikke fotografen.
--    Kommer fotografens egne billeder senere, skal den fane være hans alene.
update public.photos
   set source = 'guest'
 where guest_name = 'Engangskamera';

commit;

-- Tjek: skal give 219 rækker, navn 'Engangskamera', source 'guest'.
-- select guest_name, source, count(*) from public.photos
--  where guest_name = 'Engangskamera' group by 1,2;
