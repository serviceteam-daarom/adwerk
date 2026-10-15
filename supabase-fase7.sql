-- Fase 7: status per ontwerp, versies voor de klant en goedkeuringen

alter table public.designs add column if not exists status text not null default 'concept';
alter table public.designs add column if not exists status_at timestamptz;
do $$ begin
  alter table public.designs add constraint designs_status_check check (status in ('concept','intern','klant','aanpassen','goedgekeurd','live'));
exception when duplicate_object then null; end $$;

create table if not exists public.design_versions (
  id uuid primary key default gen_random_uuid(),
  design_id uuid not null references public.designs(id) on delete cascade,
  number int not null,
  note text check (note is null or char_length(note) <= 1000),
  data jsonb not null,
  thumbnail text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (design_id, number)
);
alter table public.design_versions enable row level security;
drop policy if exists "versions read" on public.design_versions;
create policy "versions read" on public.design_versions for select to authenticated using (public.adwerk_can_access_id(design_id));
drop policy if exists "versions insert" on public.design_versions;
create policy "versions insert" on public.design_versions for insert to authenticated with check (public.adwerk_can_access_id(design_id) and created_by = auth.uid());
drop policy if exists "versions delete" on public.design_versions;
create policy "versions delete" on public.design_versions for delete to authenticated using (exists (select 1 from public.designs d where d.id = design_id and d.owner_id = auth.uid()) or created_by = auth.uid());

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  design_id uuid not null references public.designs(id) on delete cascade,
  version int,
  decision text not null check (decision in ('approved','changes')),
  name text not null check (char_length(name) between 1 and 80),
  note text check (note is null or char_length(note) <= 2000),
  by_user uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.approvals enable row level security;
drop policy if exists "approvals read" on public.approvals;
create policy "approvals read" on public.approvals for select to authenticated using (public.adwerk_can_access_id(design_id));
drop policy if exists "approvals insert" on public.approvals;
create policy "approvals insert" on public.approvals for insert to authenticated with check (public.adwerk_can_access_id(design_id) and by_user = auth.uid());

alter table public.comments add column if not exists version int;

do $$ begin
  begin alter publication supabase_realtime add table public.design_versions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.approvals; exception when duplicate_object then null; end;
end $$;
select 'ok' as status;
