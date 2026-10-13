-- Adwerk fase 5: teamchat, hulpverzoeken en koppelingen voor AI-agents (MCP)

-- Chatberichten: recipient_id leeg = teamkanaal, anders een privébericht
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  recipient_id uuid references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  kind text not null default 'text' check (kind in ('text', 'help')),
  design_id uuid references public.designs(id) on delete set null,
  design_title text,
  created_at timestamptz not null default now()
);
create index if not exists messages_created on public.messages (created_at desc);
alter table public.messages enable row level security;
alter table public.messages replica identity full;

drop policy if exists "messages read" on public.messages;
create policy "messages read" on public.messages for select to authenticated
  using (recipient_id is null or sender_id = auth.uid() or recipient_id = auth.uid());
drop policy if exists "messages insert" on public.messages;
create policy "messages insert" on public.messages for insert to authenticated
  with check (sender_id = auth.uid());
drop policy if exists "messages delete" on public.messages;
create policy "messages delete" on public.messages for delete to authenticated using (sender_id = auth.uid());

do $$ begin
  begin alter publication supabase_realtime add table public.messages; exception when others then null; end;
end $$;

-- Hulp accepteren: wie een hulpverzoek kreeg (of het team), krijgt toegang tot dat ontwerp
create or replace function public.adwerk_accept_help(msg uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare m public.messages;
begin
  select * into m from public.messages where id = msg;
  if m.id is null or m.kind <> 'help' or m.design_id is null then raise exception 'Hulpverzoek niet gevonden'; end if;
  if not (m.recipient_id is null or m.recipient_id = auth.uid()) then raise exception 'Dit verzoek is niet voor jou'; end if;
  if m.created_at < now() - interval '7 days' then raise exception 'Dit hulpverzoek is verlopen'; end if;
  insert into public.design_members (design_id, user_id) values (m.design_id, auth.uid()) on conflict do nothing;
  return m.design_id;
end $$;
grant execute on function public.adwerk_accept_help(uuid) to authenticated;

-- Koppelingen voor AI-agents (MCP): alleen de hash van de sleutel wordt bewaard
create table if not exists public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name text not null default 'Claude',
  token_hash text not null unique,
  token_hint text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.api_tokens enable row level security;
drop policy if exists "tokens own" on public.api_tokens;
create policy "tokens own" on public.api_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

select 'ok' as status;
