-- Fjern ordet "Fotografen" fra filternavnene.
-- Rullemenuen har i forvejen overskriften "Fotografen", så det stod to
-- gange: Fotografen -> Fotografen under vielsen.

begin;

update public.photos set guest_name = 'Vielsen'
  where guest_name = 'Fotografen under vielsen';
update public.photos set guest_name = 'Receptionen'
  where guest_name = 'Fotografen under receptionen';
update public.photos set guest_name = 'Middagen'
  where guest_name = 'Fotografen under middagen';
update public.photos set guest_name = 'Brudeparbilleder'
  where guest_name = 'Fotografen brudeparbilleder';
update public.photos set guest_name = 'Før vielsen'
  where guest_name = 'Fotografen før vielsen';

commit;
