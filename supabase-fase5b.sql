-- Fase 5b: vermeldingen, bijlagen in de chat, instellingen (GIPHY) en live beelden voor agents
alter table public.messages add column if not exists mentions uuid[] not null default '{}';
alter table public.messages add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check check (kind in ('text', 'help', 'mention'));
alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages add constraint messages_body_check check (char_length(body) <= 4000 and (char_length(body) > 0 or jsonb_array_length(attachments) > 0));
create table if not exists public.app_settings (key text primary key, value text not null, updated_by uuid default auth.uid(), updated_at timestamptz not null default now());
alter table public.app_settings enable row level security;
drop policy if exists "settings read" on public.app_settings;
create policy "settings read" on public.app_settings for select to authenticated using (true);
drop policy if exists "settings write" on public.app_settings;
create policy "settings write" on public.app_settings for all to authenticated using (true) with check (true);
drop policy if exists "adwerk previews" on storage.objects;
create policy "adwerk previews" on storage.objects for insert to authenticated with check (bucket_id = 'assets' and (storage.foldername(name))[1] = 'previews');
drop policy if exists "adwerk previews update" on storage.objects;
create policy "adwerk previews update" on storage.objects for update to authenticated using (bucket_id = 'assets' and (storage.foldername(name))[1] = 'previews');
