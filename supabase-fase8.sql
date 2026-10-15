-- Fase 8: planning per ontwerp en een klantbrief per project
alter table public.designs add column if not exists start_date date;
alter table public.designs add column if not exists end_date date;
alter table public.folders add column if not exists brief jsonb;
alter table public.folders add column if not exists website text;
alter table public.folders add column if not exists color text;
alter table public.folders add column if not exists updated_at timestamptz not null default now();
select 'ok' as status;
