-- Fase 11: merkset per project
alter table public.folders add column if not exists brand_kit_id uuid references public.brand_kits(id) on delete set null;
select 'ok' as fase11;
