-- Omdøb videoerne i galleriet.
-- Ret teksten inde i apostrofferne, kør så hele blokken i SQL Editor.
-- Titlen er bare en kolonne: ingen ny omkodning, ingen ny upload, intet deploy.

begin;

-- AnnaMarie  (4:55)
update public.photos set title = 'Anna-Maries tale' where id = '900ca8db-81f8-4dfe-b53f-051381b19081';
-- Bruden  (12:27)
update public.photos set title = 'Brudens tale' where id = '285610a1-4419-48eb-80e5-373d97e746b9';
-- BrudenSang  (0:20)
update public.photos set title = 'Sang til bruden' where id = 'dcd3ceb0-182a-4060-a73d-f30ff85e3a09';
-- Gommen  (11:59)
update public.photos set title = 'Gommens tale' where id = 'cd4f9530-f423-43e6-a06d-2a922e14c75e';
-- HelleHenrik  (11:56)
update public.photos set title = 'Helle og Henriks tale' where id = '097fb2ec-03a7-4dad-a6b6-6aaa0701bf3e';
-- JacobPeter  (8:59)
update public.photos set title = 'Jacob og Peters tale' where id = '8478cd9c-b685-4eef-90aa-f387b58da10c';
-- Julie  (7:44)
update public.photos set title = 'Julies tale' where id = '435990a3-4fed-4943-9bed-787bf9cf5524';
-- Kresten  (9:59)
update public.photos set title = 'Krestens tale' where id = 'a3cac0e2-8653-4939-b789-8bd9cd4bcb3b';
-- KysPåGommen  (0:06)
update public.photos set title = 'Kys på gommen' where id = '41f4b6a2-4bf8-465e-b20e-afa9a0c5d801';
-- KysPåGommenDel2  (0:15)
update public.photos set title = 'Kys på gommen, del 2' where id = '398f85a6-1a64-490a-b66e-93c67e22fa1e';
-- LineLotte  (7:15)
update public.photos set title = 'Line og Lottes tale' where id = 'ce489127-7296-45ca-b17c-662b7fbddc70';
-- MadsGitteHeidi  (8:04)
update public.photos set title = 'Mads, Gitte og Heidis tale' where id = '63ac0697-ebfd-4050-a428-d6016335ef49';
-- MBDorte  (5:43)
update public.photos set title = 'Maj-Britt og Dortes tale' where id = '24936855-53d6-4820-ba8b-ad9c5520d275';
-- Patrick  (6:52)
update public.photos set title = 'Patricks tale' where id = '2bb655f6-4bae-4284-a036-abb51ed57044';
-- Tore  (6:53)
update public.photos set title = 'Tores tale' where id = '3f816269-7015-4e05-8a0b-b303f8c07b05';

commit;
