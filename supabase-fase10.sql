-- Fase 10: eigen volgorde van projecten (per persoon) en volgorde van bestanden in een project (gedeeld)
create table if not exists public.folder_order (
  user_id uuid not null references auth.users(id) on delete cascade,
  folder_id uuid not null references public.folders(id) on delete cascade,
  position int not null default 0,
  primary key (user_id, folder_id)
);
alter table public.folder_order enable row level security;
drop policy if exists "order own select" on public.folder_order;
drop policy if exists "order own insert" on public.folder_order;
drop policy if exists "order own update" on public.folder_order;
drop policy if exists "order own delete" on public.folder_order;
create policy "order own select" on public.folder_order for select to authenticated using (user_id = auth.uid());
create policy "order own insert" on public.folder_order for insert to authenticated with check (user_id = auth.uid());
create policy "order own update" on public.folder_order for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "order own delete" on public.folder_order for delete to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on public.folder_order to authenticated;

alter table public.designs add column if not exists position double precision;
create index if not exists designs_folder_position on public.designs (folder_id, position);
select 'ok' as fase10;
