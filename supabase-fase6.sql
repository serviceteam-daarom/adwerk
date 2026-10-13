-- Fase 6: opmerkingen (collega's en klanten) en deellinks voor feedback

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  design_id uuid not null references public.designs(id) on delete cascade,
  frame_id text,
  x real, y real,
  element_id text,
  parent_id uuid references public.comments(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  author_id uuid references public.profiles(id) on delete set null default auth.uid(),
  guest_name text check (guest_name is null or char_length(guest_name) between 1 and 60),
  resolved boolean not null default false,
  resolved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists comments_design on public.comments (design_id, created_at);
alter table public.comments enable row level security;
alter table public.comments replica identity full;

create or replace function public.adwerk_can_access_id(did uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.designs d where d.id = did and public.adwerk_can_access(d))
$$;
grant execute on function public.adwerk_can_access_id(uuid) to authenticated;

drop policy if exists "comments read" on public.comments;
create policy "comments read" on public.comments for select to authenticated using (public.adwerk_can_access_id(design_id));
drop policy if exists "comments insert" on public.comments;
create policy "comments insert" on public.comments for insert to authenticated with check (author_id = auth.uid() and guest_name is null and public.adwerk_can_access_id(design_id));
drop policy if exists "comments update" on public.comments;
create policy "comments update" on public.comments for update to authenticated using (public.adwerk_can_access_id(design_id));
drop policy if exists "comments delete" on public.comments;
create policy "comments delete" on public.comments for delete to authenticated using (author_id = auth.uid() or exists (select 1 from public.designs d where d.id = design_id and d.owner_id = auth.uid()));

-- Deellinks: een geheime link waarmee klanten zonder account kunnen meekijken en reageren
create table if not exists public.share_links (
  id uuid primary key default gen_random_uuid(),
  design_id uuid not null references public.designs(id) on delete cascade,
  token text not null unique,
  can_comment boolean not null default true,
  label text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  revoked boolean not null default false,
  last_used_at timestamptz
);
alter table public.share_links enable row level security;
drop policy if exists "links read" on public.share_links;
create policy "links read" on public.share_links for select to authenticated using (public.adwerk_can_access_id(design_id));
drop policy if exists "links write" on public.share_links;
create policy "links write" on public.share_links for all to authenticated using (public.adwerk_can_access_id(design_id)) with check (public.adwerk_can_access_id(design_id));

do $$ begin
  begin alter publication supabase_realtime add table public.comments; exception when duplicate_object then null; end;
end $$;
select 'ok' as status;
