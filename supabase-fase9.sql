-- Fase 9: status "analyseren" en persoonlijke vastgezette projecten
alter table public.designs drop constraint if exists designs_status_check;
alter table public.designs add constraint designs_status_check check (status in ('concept','intern','klant','aanpassen','goedgekeurd','live','analyseren'));

create table if not exists public.folder_pins (
  user_id uuid not null references auth.users(id) on delete cascade,
  folder_id uuid not null references public.folders(id) on delete cascade,
  position int not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, folder_id)
);
alter table public.folder_pins enable row level security;
drop policy if exists "pins own select" on public.folder_pins;
drop policy if exists "pins own insert" on public.folder_pins;
drop policy if exists "pins own update" on public.folder_pins;
drop policy if exists "pins own delete" on public.folder_pins;
create policy "pins own select" on public.folder_pins for select to authenticated using (user_id = auth.uid());
create policy "pins own insert" on public.folder_pins for insert to authenticated with check (user_id = auth.uid());
create policy "pins own update" on public.folder_pins for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "pins own delete" on public.folder_pins for delete to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on public.folder_pins to authenticated;
select 'ok' as fase9;
